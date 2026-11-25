import { adminClient } from "../../lib/supabase";

/** Who gets news and offers by email (Marketing -> Subscribers). */

export type SubscriberStatus = "subscribed" | "unsubscribed" | "bounced" | "no_email";

export interface Subscriber {
  user_id: string;
  name: string | null;
  email: string | null;
  roles: string[];
  status: SubscriberStatus;
  status_since: string | null;
  joined_at: string;
}

export async function listSubscribers(q: { status?: SubscriberStatus; role?: "booker" | "host"; search?: string; page: number; pageSize: number }): Promise<{ data: Subscriber[]; total: number }> {
  const search = q.search?.replace(/[%_\\]/g, " ").trim() || null;
  const { data, error } = await adminClient.rpc("admin_email_subscribers", {
    _status: q.status ?? null,
    _role: q.role ?? null,
    _search: search,
    _limit: q.pageSize,
    _offset: (q.page - 1) * q.pageSize,
  });
  if (error) throw error;
  const rows = (data ?? []) as (Subscriber & { total_count: number })[];
  return {
    data: rows.map(({ total_count: _total, ...r }) => r),
    total: rows.length ? Number(rows[0]!.total_count) : 0,
  };
}

export async function subscriberSummary() {
  const { data, error } = await adminClient.rpc("admin_email_subscriber_summary").single();
  if (error) throw error;
  const r = data as Record<string, number | string>;
  return {
    people: Number(r.people),
    subscribed: Number(r.subscribed),
    unsubscribed: Number(r.unsubscribed),
    bounced: Number(r.bounced),
    no_email: Number(r.no_email),
    hosts_subscribed: Number(r.hosts_subscribed),
    bookers_subscribed: Number(r.bookers_subscribed),
  };
}
