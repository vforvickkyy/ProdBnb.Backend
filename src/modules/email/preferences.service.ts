import { adminClient } from "../../lib/supabase";
import { emailOf } from "./context";

/**
 * What someone gets by email, from their own account settings.
 *
 * Booking, payment and account emails always go out (they're part of using the service). The one
 * choice is "news and offers": announcements sent from the admin. It shares the do-not-email list
 * with the unsubscribe link in those emails, so the link and this switch always agree.
 */
export interface EmailPreferences {
  email: string | null;
  news_and_offers: boolean;
  /** The address bounced: nothing reaches it. Shown so the person can fix their email. */
  address_blocked: boolean;
}

export async function getEmailPreferences(userId: string): Promise<EmailPreferences> {
  const email = await emailOf(userId);
  if (!email) return { email: null, news_and_offers: false, address_blocked: false };
  const { data } = await adminClient.from("email_suppressions").select("reason").eq("email", email.toLowerCase()).maybeSingle();
  return {
    email,
    news_and_offers: !data,
    address_blocked: data?.reason === "bounced",
  };
}

export async function updateEmailPreferences(userId: string, input: { news_and_offers: boolean }): Promise<EmailPreferences> {
  const email = (await emailOf(userId))?.toLowerCase();
  if (!email) return getEmailPreferences(userId);
  if (input.news_and_offers) {
    // Only lift the person's own opt-out; a bounce or a block set by the team stays.
    await adminClient.from("email_suppressions").delete().eq("email", email).eq("reason", "unsubscribed");
  } else {
    await adminClient.from("email_suppressions").upsert({ email, reason: "unsubscribed", user_id: userId }, { onConflict: "email", ignoreDuplicates: true });
  }
  return getEmailPreferences(userId);
}
