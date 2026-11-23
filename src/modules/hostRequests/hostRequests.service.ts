import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import {
  AdminHostRequestsQuery,
  HostRequestBestTime,
  HostRequestInput,
  HostRequestStatus,
  UpdateHostRequestInput,
} from "./hostRequests.schema";

/**
 * "Request a callback" for people who want to list a place (see the migration
 * 20261123160000_host_assistance_requests.sql). Reads and writes use the service-role client: the
 * person's own rows are also readable under RLS, but every write is the backend's.
 */

const TABLE = "host_assistance_requests";
const UNIQUE_VIOLATION = "23505";
const OPEN_STATUSES: HostRequestStatus[] = ["new", "contacted"];

export type HostRequestSource = "ios" | "android" | "web";

/** What the person sees of their own request (never the team's notes). */
export interface HostRequest {
  id: string;
  user_id: string;
  location_id: string | null;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  space_type: string | null;
  best_time: HostRequestBestTime;
  note: string | null;
  source: HostRequestSource;
  status: HostRequestStatus;
  contacted_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, user_id, location_id, name, phone, email, city, space_type, best_time, note, source, status, contacted_at, closed_at, created_at, updated_at";

export interface AdminHostRequest extends HostRequest {
  admin_notes: string | null;
  handled_by: string | null;
  user: { id: string; first_name: string | null; last_name: string | null; status: string } | null;
  listing: { id: string; title: string; status: string; listing_code: string | null; city: string | null } | null;
  handler: { id: string; first_name: string | null; last_name: string | null } | null;
}

const ADMIN_COLUMNS = `${COLUMNS}, admin_notes, handled_by,
  user:profiles!user_id(id, first_name, last_name, status),
  listing:locations!location_id(id, title, status, listing_code, city),
  handler:profiles!handled_by(id, first_name, last_name)`;

// -- The person's side ----------------------------------------------------------------------------

/** Their open request if they have one, otherwise their latest (so "we called you" can show). */
export async function getMyHostRequest(userId: string): Promise<HostRequest | null> {
  const { data, error } = await adminClient
    .from(TABLE)
    .select(COLUMNS)
    .eq("user_id", userId)
    .neq("status", "withdrawn")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  const rows = (data ?? []) as HostRequest[];
  return rows.find((row) => OPEN_STATUSES.includes(row.status)) ?? rows[0] ?? null;
}

async function findOpen(userId: string): Promise<HostRequest | null> {
  const { data, error } = await adminClient.from(TABLE).select(COLUMNS).eq("user_id", userId).in("status", OPEN_STATUSES).maybeSingle();
  if (error) throw error;
  return (data as HostRequest | null) ?? null;
}

async function assertOwnListing(userId: string, locationId: string): Promise<void> {
  const { data, error } = await adminClient.from("locations").select("id").eq("id", locationId).eq("host_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ValidationError("That listing isn't one of yours.", { location_id: ["That listing isn't one of yours."] });
  }
}

/**
 * Files a callback request, or -- when one is already open -- updates it with the new details, so
 * asking twice never makes two. `created` tells the caller which happened.
 */
export async function submitHostRequest(
  user: { id: string; email: string | null },
  input: HostRequestInput,
  source: HostRequestSource
): Promise<{ request: HostRequest; created: boolean }> {
  if (input.location_id) {
    await assertOwnListing(user.id, input.location_id);
  }
  const fields = {
    name: input.name,
    phone: input.phone,
    city: input.city ?? null,
    space_type: input.space_type ?? null,
    best_time: input.best_time,
    note: input.note ?? null,
    email: user.email,
  };

  const update = async (open: HostRequest): Promise<HostRequest> => {
    const { data, error } = await adminClient
      .from(TABLE)
      .update({
        ...fields,
        // Keep the listing they named before unless they name another one.
        location_id: input.location_id === undefined ? open.location_id : input.location_id,
        source,
      })
      .eq("id", open.id)
      .select(COLUMNS)
      .single();
    if (error) throw error;
    return data as HostRequest;
  };

  const open = await findOpen(user.id);
  if (open) {
    return { request: await update(open), created: false };
  }

  const { data, error } = await adminClient
    .from(TABLE)
    .insert({ ...fields, user_id: user.id, location_id: input.location_id ?? null, source })
    .select(COLUMNS)
    .single();
  if (error) {
    // Two taps at once: the other request won the one-open-per-person index. Update that one.
    if (error.code === UNIQUE_VIOLATION) {
      const winner = await findOpen(user.id);
      if (winner) return { request: await update(winner), created: false };
    }
    throw error;
  }
  return { request: data as HostRequest, created: true };
}

/** The person no longer wants a call. */
export async function withdrawHostRequest(userId: string): Promise<HostRequest> {
  const open = await findOpen(userId);
  if (!open) {
    throw new NotFoundError("You have no open callback request.");
  }
  const { data, error } = await adminClient
    .from(TABLE)
    .update({ status: "withdrawn", closed_at: new Date().toISOString() })
    .eq("id", open.id)
    .in("status", OPEN_STATUSES)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ConflictError("This request was just updated by our team. Pull to refresh.");
  }
  return data as HostRequest;
}

// -- The team's side ------------------------------------------------------------------------------

/** PostgREST's `or()` syntax treats these as structure; a search term must not contain them. */
function searchTerm(raw: string): string {
  return raw.replace(/[,()*%\\]/g, " ").trim();
}

export async function listAdminHostRequests(query: AdminHostRequestsQuery): Promise<{ data: AdminHostRequest[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  const waiting = query.status === "open" || query.status === "new" || query.status === "contacted";
  let q = adminClient
    .from(TABLE)
    .select(ADMIN_COLUMNS, { count: "exact" })
    // Waiting requests: who has waited longest first. Everything else: newest first.
    .order("created_at", { ascending: waiting })
    .range(from, from + query.pageSize - 1);
  if (query.status === "open") {
    q = q.in("status", OPEN_STATUSES);
  } else if (query.status) {
    q = q.eq("status", query.status);
  }
  if (query.search) {
    const term = searchTerm(query.search);
    if (term) {
      q = q.or(`name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%,city.ilike.%${term}%`);
    }
  }
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as AdminHostRequest[];
  return { data: rows, total: count ?? rows.length };
}

/** For the console's sidebar count and the page's tabs. */
export async function hostRequestSummary(): Promise<{ new: number; contacted: number }> {
  const count = async (status: HostRequestStatus) => {
    const { count: n, error } = await adminClient.from(TABLE).select("id", { count: "exact", head: true }).eq("status", status);
    if (error) throw error;
    return n ?? 0;
  };
  const [fresh, contacted] = await Promise.all([count("new"), count("contacted")]);
  return { new: fresh, contacted };
}

async function getAdminHostRequest(id: string): Promise<AdminHostRequest> {
  const { data, error } = await adminClient.from(TABLE).select(ADMIN_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Callback request not found.");
  return data as unknown as AdminHostRequest;
}

/** Move a request along (New -> Contacted -> Done / Closed) and keep the team's notes. */
export async function updateHostRequest(adminId: string, id: string, input: UpdateHostRequestInput): Promise<AdminHostRequest> {
  const current = await getAdminHostRequest(id);
  if (input.status && current.status === "withdrawn") {
    throw new ConflictError("They withdrew this request, so its status can't change. You can still add notes.");
  }

  const patch: Record<string, unknown> = { handled_by: adminId };
  if (input.admin_notes !== undefined) {
    patch.admin_notes = input.admin_notes && input.admin_notes.length > 0 ? input.admin_notes : null;
  }
  if (input.status && input.status !== current.status) {
    const now = new Date().toISOString();
    patch.status = input.status;
    if (input.status === "contacted" && !current.contacted_at) patch.contacted_at = now;
    if (input.status === "done" || input.status === "closed") patch.closed_at = now;
    if (input.status === "new" || input.status === "contacted") patch.closed_at = null;
  }

  const { error } = await adminClient.from(TABLE).update(patch).eq("id", id);
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ConflictError("This person already has another open request. Close that one first.");
    }
    throw error;
  }
  return getAdminHostRequest(id);
}
