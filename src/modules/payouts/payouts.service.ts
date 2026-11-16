import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { adminClient } from "../../lib/supabase";
import { writeAuditLog } from "../admin/audit.service";
import { hostEarnings, loadEarnings, summarise } from "./earnings.service";
import { ListPayoutsQuery, RecordPayoutInput, SavePayoutAccountInput } from "./payouts.schema";

/** Payout accounts (bank details in Vault) and the payouts the team records. */

export interface PayoutAccount {
  account_holder_name: string;
  account_last4: string;
  ifsc: string;
  bank_name: string | null;
  /** Last five characters of the PAN, e.g. "1234F". */
  pan_last4: string;
  updated_at: string;
}

const ACCOUNT_COLUMNS = "account_holder_name, account_last4, ifsc, bank_name, pan_last4, updated_at";

export async function getPayoutAccount(userId: string): Promise<PayoutAccount | null> {
  const { data, error } = await adminClient.from("host_payout_accounts").select(ACCOUNT_COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as PayoutAccount | null) ?? null;
}

export async function savePayoutAccount(userId: string, input: SavePayoutAccountInput): Promise<PayoutAccount> {
  const { error } = await adminClient.rpc("host_payout_account_save", {
    _user_id: userId,
    _holder: input.account_holder_name,
    _account_number: input.account_number,
    _ifsc: input.ifsc,
    _bank_name: input.bank_name ?? null,
    _pan: input.pan,
  });
  if (error) throw error;
  return (await getPayoutAccount(userId))!;
}

export async function removePayoutAccount(userId: string): Promise<boolean> {
  const { data, error } = await adminClient.rpc("host_payout_account_remove", { _user_id: userId });
  if (error) throw error;
  return Boolean(data);
}

export interface Payout {
  id: string;
  host_id: string;
  amount_minor_units: number;
  currency: string;
  reference: string;
  paid_at: string;
  note: string | null;
  account_last4: string | null;
  ifsc: string | null;
  created_at: string;
  booking_count: number;
}

const PAYOUT_COLUMNS = "id, host_id, amount_minor_units, currency, reference, paid_at, note, account_last4, ifsc, created_at, items:host_payout_items(booking_id)";

function toPayout(row: Omit<Payout, "booking_count"> & { items: { booking_id: string }[] | null }): Payout {
  const { items, ...rest } = row;
  return { ...rest, booking_count: (items ?? []).length };
}

export async function listPayouts(query: ListPayoutsQuery): Promise<{ data: Payout[]; total: number }> {
  const from = (query.page - 1) * query.pageSize;
  let q = adminClient.from("host_payouts").select(PAYOUT_COLUMNS, { count: "exact" }).order("paid_at", { ascending: false }).range(from, from + query.pageSize - 1);
  if (query.host_id) q = q.eq("host_id", query.host_id);
  const { data, error, count } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Parameters<typeof toPayout>[0][]).map(toPayout);
  return { data: rows, total: count ?? rows.length };
}

// Admin -----------------------------------------------------------------------------------------

export interface HostDue {
  host: { id: string; first_name: string | null; last_name: string | null };
  ready_minor_units: number;
  ready_bookings: number;
  on_hold_minor_units: number;
  currency: string;
  account: PayoutAccount | null;
}

/** Hosts the team owes money to now (and what's on hold), largest first. */
export async function listDue(): Promise<HostDue[]> {
  const rows = await loadEarnings();
  const byHost = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.state !== "ready" && r.state !== "on_hold") continue;
    byHost.set(r.host_id, [...(byHost.get(r.host_id) ?? []), r]);
  }
  const ids = [...byHost.keys()];
  if (ids.length === 0) return [];
  const [{ data: profiles, error: e1 }, { data: accounts, error: e2 }] = await Promise.all([
    adminClient.from("profiles").select("id, first_name, last_name").in("id", ids),
    adminClient.from("host_payout_accounts").select(`user_id, ${ACCOUNT_COLUMNS}`).in("user_id", ids),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  const accountById = new Map((accounts ?? []).map((a) => [a.user_id as string, a]));
  return ids
    .map((id) => {
      const mine = byHost.get(id)!;
      const ready = mine.filter((r) => r.state === "ready");
      const account = accountById.get(id);
      const { user_id: _u, ...masked } = (account ?? {}) as PayoutAccount & { user_id?: string };
      return {
        host: (profileById.get(id) as HostDue["host"] | undefined) ?? { id, first_name: null, last_name: null },
        ready_minor_units: ready.reduce((s, r) => s + r.net_minor_units, 0),
        ready_bookings: ready.length,
        on_hold_minor_units: mine.filter((r) => r.state === "on_hold").reduce((s, r) => s + r.net_minor_units, 0),
        currency: mine[0]?.currency ?? "INR",
        account: account ? (masked as PayoutAccount) : null,
      };
    })
    .sort((a, b) => b.ready_minor_units - a.ready_minor_units);
}

export async function adminHostEarnings(hostId: string) {
  const { data: profile, error } = await adminClient.from("profiles").select("id, first_name, last_name").eq("id", hostId).maybeSingle();
  if (error) throw error;
  if (!profile) throw new NotFoundError("Host not found.");
  const [earnings, account] = await Promise.all([hostEarnings(hostId), getPayoutAccount(hostId)]);
  return { host: profile, account, ...earnings };
}

/** The full account number and PAN, to make a transfer. Always written to the audit log. */
export async function revealPayoutAccount(adminId: string, hostId: string, reason: string | null) {
  const account = await getPayoutAccount(hostId);
  if (!account) throw new NotFoundError("This host hasn't added payout details yet.");
  const { data, error } = await adminClient.rpc("host_payout_account_reveal", { _user_id: hostId });
  if (error) throw error;
  const secret = (data as { account_number: string; pan: string }[] | null)?.[0];
  if (!secret) throw new NotFoundError("Payout details not found.");
  await writeAuditLog(adminId, "ADMIN_VIEWED_PAYOUT_DETAILS", "payout_account", hostId, reason, { ifsc: account.ifsc, account_last4: account.account_last4 });
  return { ...account, account_number: secret.account_number, pan: secret.pan };
}

export async function recordPayout(adminId: string, hostId: string, input: RecordPayoutInput): Promise<Payout> {
  const account = await getPayoutAccount(hostId);
  if (!account) throw new ValidationError("This host hasn't added payout details yet.");
  const { rows } = await hostEarnings(hostId);
  const byId = new Map(rows.map((r) => [r.booking_id, r]));
  const unique = [...new Set(input.booking_ids)];
  const notReady = unique.filter((id) => byId.get(id)?.state !== "ready");
  if (notReady.length > 0) {
    throw new ValidationError(`${notReady.length} of these bookings ${notReady.length === 1 ? "isn't" : "aren't"} ready to pay out. Refresh and try again.`, {
      booking_ids: notReady,
    });
  }
  const items = unique.map((id) => ({ booking_id: id, amount_minor_units: byId.get(id)!.net_minor_units }));
  const amount = items.reduce((s, i) => s + i.amount_minor_units, 0);
  if (amount <= 0) throw new ValidationError("There is nothing to pay for these bookings.");

  const { data: payout, error } = await adminClient
    .from("host_payouts")
    .insert({
      host_id: hostId,
      amount_minor_units: amount,
      currency: byId.get(unique[0]!)!.currency,
      reference: input.reference,
      paid_at: input.paid_at ?? new Date().toISOString(),
      note: input.note ?? null,
      account_last4: account.account_last4,
      ifsc: account.ifsc,
      created_by: adminId,
    })
    .select("id")
    .single();
  if (error) throw error;
  const { error: itemsError } = await adminClient.from("host_payout_items").insert(items.map((i) => ({ ...i, payout_id: payout.id })));
  if (itemsError) {
    // Someone recorded one of these bookings a moment ago: undo this payout rather than half-record it.
    await adminClient.from("host_payouts").delete().eq("id", payout.id);
    if (itemsError.code === "23505") throw new ConflictError("Some of these bookings were just paid out by someone else. Refresh and try again.");
    throw itemsError;
  }
  await writeAuditLog(adminId, "ADMIN_RECORDED_PAYOUT", "payout", payout.id, input.note ?? null, {
    host_id: hostId,
    amount_minor_units: amount,
    reference: input.reference,
    booking_ids: unique,
  });
  const { data: saved, error: readError } = await adminClient.from("host_payouts").select(PAYOUT_COLUMNS).eq("id", payout.id).single();
  if (readError) throw readError;
  return toPayout(saved as unknown as Parameters<typeof toPayout>[0]);
}

export { summarise };
