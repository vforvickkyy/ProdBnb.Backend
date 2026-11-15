import { NotFoundError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";

/**
 * Dispute message access (Admin Console) -- the "later Phase 27 sub-phase" docs/DATABASE.md
 * reserved `admin_message_access` for.
 *
 * Two deliberately different reads:
 *
 *  1. FINDING a conversation (`listConversationsForAdmin`) returns METADATA ONLY -- who, which
 *     listing, which booking, when, how many messages. Never a body, never a preview. An admin
 *     needs to locate the thread a dispute is about without that search itself being a read of
 *     anyone's correspondence.
 *
 *  2. READING one (`openConversationForAdmin`) requires a stated reason and writes the
 *     `admin_message_access` record FIRST -- if that insert fails, no message is returned. The
 *     record is append-only and admin-unwritable (Phase 27-1 + the grant hardening migration), so
 *     no admin can read correspondence without leaving a trail they cannot erase.
 *
 * Both run on the service-role client after the API's own `messages.access` permission check:
 * participant RLS deliberately has no admin arm (Phase 27-2), and widening it would make an admin
 * read invisible -- the exact thing this design exists to prevent.
 */

export interface AdminConversationSummary {
  id: string;
  booker: { id: string; first_name: string | null; last_name: string | null };
  host: { id: string; first_name: string | null; last_name: string | null } | null;
  location: { id: string; title: string; city: string } | null;
  booking_id: string | null;
  message_count: number;
  last_message_at: string;
  created_at: string;
}

export interface AdminConversationMessage {
  id: string;
  sender_id: string;
  sender_role: "booker" | "host" | "other";
  body: string;
  created_at: string;
}

export interface AdminConversationTranscript {
  conversation: AdminConversationSummary;
  messages: AdminConversationMessage[];
  /** True when the thread is longer than `MAX_TRANSCRIPT` and only the newest were returned. */
  truncated: boolean;
  access_id: string;
}

export interface MessageAccessLogEntry {
  id: string;
  admin_user_id: string;
  admin: { first_name: string | null; last_name: string | null } | null;
  conversation_id: string;
  action: string;
  reason: string;
  created_at: string;
}

export interface ListAdminConversationsQuery {
  booker_id?: string;
  host_id?: string;
  location_id?: string;
  booking_id?: string;
  page: number;
  pageSize: number;
}

const MAX_TRANSCRIPT = 1000;

const SUMMARY_SELECT = `
  id, booker_id, location_id, booking_id, last_message_at, created_at,
  booker:profiles!conversations_booker_id_fkey ( id, first_name, last_name ),
  location:locations!conversations_location_id_fkey ( id, title, city, host_id,
    host:profiles!locations_host_id_fkey ( id, first_name, last_name ) ),
  messages:messages!messages_conversation_id_fkey ( count )
`;

interface RawSummaryRow {
  id: string;
  booker_id: string;
  location_id: string;
  booking_id: string | null;
  last_message_at: string;
  created_at: string;
  booker: { id: string; first_name: string | null; last_name: string | null } | null;
  location: {
    id: string;
    title: string;
    city: string;
    host_id: string;
    host: { id: string; first_name: string | null; last_name: string | null } | null;
  } | null;
  messages: { count: number }[] | null;
}

function toSummary(row: RawSummaryRow): AdminConversationSummary {
  return {
    id: row.id,
    booker: row.booker ?? { id: row.booker_id, first_name: null, last_name: null },
    host: row.location?.host ?? (row.location ? { id: row.location.host_id, first_name: null, last_name: null } : null),
    location: row.location ? { id: row.location.id, title: row.location.title, city: row.location.city } : null,
    booking_id: row.booking_id,
    message_count: row.messages?.[0]?.count ?? 0,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
  };
}

export async function listConversationsForAdmin(
  query: ListAdminConversationsQuery
): Promise<{ data: AdminConversationSummary[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  // Filtering on an embedded column only restricts the OUTER rows when the embed is `!inner`
  // (the same PostgREST rule bookings.service.ts relies on for host_id).
  const select = query.host_id
    ? SUMMARY_SELECT.replace("locations!conversations_location_id_fkey (", "locations!conversations_location_id_fkey!inner (")
    : SUMMARY_SELECT;

  let request = adminClient.from("conversations").select(select, { count: "exact" });
  if (query.booker_id) request = request.eq("booker_id", query.booker_id);
  if (query.location_id) request = request.eq("location_id", query.location_id);
  if (query.booking_id) request = request.eq("booking_id", query.booking_id);
  if (query.host_id) request = request.eq("location.host_id", query.host_id);

  const { data, error, count } = await request.order("last_message_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (error) {
    throw error;
  }
  return { data: ((data ?? []) as unknown as RawSummaryRow[]).map(toSummary), total: count ?? 0 };
}

async function getSummary(conversationId: string): Promise<AdminConversationSummary> {
  const { data, error } = await adminClient.from("conversations").select(SUMMARY_SELECT).eq("id", conversationId).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new NotFoundError("Conversation not found.");
  }
  return toSummary(data as unknown as RawSummaryRow);
}

export async function openConversationForAdmin(
  adminId: string,
  conversationId: string,
  reason: string
): Promise<AdminConversationTranscript> {
  const conversation = await getSummary(conversationId);

  // The record comes first. No record, no messages.
  const { data: access, error: accessError } = await adminClient
    .from("admin_message_access")
    .insert({ admin_user_id: adminId, conversation_id: conversationId, action: "view_conversation", reason })
    .select("id")
    .single();
  if (accessError || !access) {
    throw accessError ?? new Error("Failed to record message access.");
  }

  const { data, error } = await adminClient
    .from("messages")
    .select("id, sender_id, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MAX_TRANSCRIPT + 1);
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as { id: string; sender_id: string; body: string; created_at: string }[];
  const truncated = rows.length > MAX_TRANSCRIPT;
  const newestFirst = truncated ? rows.slice(0, MAX_TRANSCRIPT) : rows;

  const messages = newestFirst.reverse().map((m) => ({
    ...m,
    sender_role:
      m.sender_id === conversation.booker.id ? ("booker" as const) : m.sender_id === conversation.host?.id ? ("host" as const) : ("other" as const),
  }));

  return { conversation, messages, truncated, access_id: access.id };
}

export async function listMessageAccessLog(query: {
  conversation_id?: string;
  admin_user_id?: string;
  page: number;
  pageSize: number;
}): Promise<{ data: MessageAccessLogEntry[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let request = adminClient
    .from("admin_message_access")
    .select(
      "id, admin_user_id, conversation_id, action, reason, created_at, admin:profiles!admin_message_access_admin_user_id_fkey ( first_name, last_name )",
      { count: "exact" }
    );
  if (query.conversation_id) request = request.eq("conversation_id", query.conversation_id);
  if (query.admin_user_id) request = request.eq("admin_user_id", query.admin_user_id);

  const { data, error, count } = await request.order("created_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (error) {
    throw error;
  }
  return { data: (data ?? []) as unknown as MessageAccessLogEntry[], total: count ?? 0 };
}
