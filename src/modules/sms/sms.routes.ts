import { Request, Response, Router } from "express";
import { z } from "zod";
import { adminClient } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { requirePermission as can } from "../admin/permissions";
import { SAMPLE_VARS } from "./content";
import { listSms, listTemplates, phoneOf, previewTemplate, resendSms, sendTestSms, smsSummary, updateTemplate } from "./outbox.service";
import { SMS_PROVIDERS } from "./providers";
import { removeProvider, saveProvider, smsOverview, updateSmsSettings } from "./settings.service";
import { dltForm, maskPhone, placeholders } from "./text";

/** The signed-in person's SMS switch (account settings on the website and apps). */
export const smsMeRouter = Router();

async function myPreferences(userId: string) {
  const { phone, smsUpdates } = await phoneOf(userId);
  return { phone: phone ? maskPhone(phone) : null, has_phone: Boolean(phone), sms_updates: smsUpdates };
}

smsMeRouter.get("/me/sms-preferences", requireAuth, async (req: Request, res: Response) => {
  ok(res, await myPreferences(req.user!.id));
});

const prefsBody = z.object({ sms_updates: z.boolean() }).strict();

smsMeRouter.patch("/me/sms-preferences", requireAuth, validate({ body: prefsBody }), async (req: Request, res: Response) => {
  const body = req.valid!.body as z.infer<typeof prefsBody>;
  const { error } = await adminClient.from("profiles").update({ sms_updates: body.sms_updates }).eq("id", req.user!.id);
  if (error) throw error;
  ok(res, await myPreferences(req.user!.id));
});

/** Admin: Messaging -> SMS. Mounted inside the admin router. */
export const adminSmsRouter = Router();

adminSmsRouter.get("/sms/settings", can("campaigns.view"), async (_req: Request, res: Response) => {
  ok(res, await smsOverview());
});

const settingsBody = z
  .object({
    mode: z.enum(["off", "test", "live"]).optional(),
    active_provider: z.enum(SMS_PROVIDERS).nullable().optional(),
    sender_id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{3,11}$/, "The sender name is 3-11 letters or digits (DLT headers are usually 6 letters).")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    dlt_entity_id: z
      .string()
      .trim()
      .regex(/^[0-9]{6,30}$/, "The DLT entity ID is digits only.")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    test_numbers: z.array(z.string().trim().min(6).max(20)).max(20).optional(),
    otp_per_hour: z.number().int().min(1).max(30).optional(),
  })
  .strict();

adminSmsRouter.patch("/sms/settings", can("channels.manage"), validate({ body: settingsBody }), async (req: Request, res: Response) => {
  await updateSmsSettings(req.user!.id, req.valid!.body as z.infer<typeof settingsBody>);
  ok(res, await smsOverview());
});

const providerParams = z.object({ provider: z.enum(SMS_PROVIDERS) });
const providerBody = z.record(z.string().max(2000)).refine((v) => Object.keys(v).length <= 10, "Too many fields.");

adminSmsRouter.put("/sms/providers/:provider", can("channels.manage"), validate({ params: providerParams, body: providerBody }), async (req: Request, res: Response) => {
  await saveProvider(req.user!.id, (req.valid!.params as { provider: string }).provider, req.valid!.body as Record<string, string>);
  ok(res, await smsOverview());
});

adminSmsRouter.delete("/sms/providers/:provider", can("channels.manage"), validate({ params: providerParams }), async (req: Request, res: Response) => {
  await removeProvider(req.user!.id, (req.valid!.params as { provider: string }).provider);
  ok(res, await smsOverview());
});

adminSmsRouter.get("/sms/templates", can("campaigns.view"), async (_req: Request, res: Response) => {
  const rows = await listTemplates();
  ok(
    res,
    rows.map((t) => ({
      ...t,
      dlt_text: dltForm(t.body),
      variables: placeholders(t.body).filter((p) => p !== "brand" && p !== "site"),
      preview: previewTemplate(t.body),
    }))
  );
});

const templateParams = z.object({ key: z.string().regex(/^[a-z0-9_]{2,60}$/) });
const templateBody = z
  .object({
    body: z.string().trim().min(10).max(1000).optional(),
    dlt_template_id: z.string().trim().regex(/^[0-9]{6,30}$/, "The DLT template ID is digits only.").nullable().optional().or(z.literal("").transform(() => null)),
    provider_template_id: z.string().trim().max(100).nullable().optional().or(z.literal("").transform(() => null)),
    enabled: z.boolean().optional(),
  })
  .strict();

adminSmsRouter.patch("/sms/templates/:key", can("channels.manage"), validate({ params: templateParams, body: templateBody }), async (req: Request, res: Response) => {
  const t = await updateTemplate(req.user!.id, (req.valid!.params as { key: string }).key, req.valid!.body as z.infer<typeof templateBody>);
  ok(res, { ...t, dlt_text: dltForm(t.body), variables: placeholders(t.body).filter((p) => p !== "brand" && p !== "site"), preview: previewTemplate(t.body) });
});

const previewBody = z.object({ body: z.string().max(1000) }).strict();

adminSmsRouter.post("/sms/preview", can("campaigns.view"), validate({ body: previewBody }), async (req: Request, res: Response) => {
  const { body } = req.valid!.body as z.infer<typeof previewBody>;
  ok(res, { ...previewTemplate(body), dlt_text: dltForm(body), sample_values: SAMPLE_VARS });
});

const testBody = z.object({ phone: z.string().trim().min(6).max(20), template: z.string().regex(/^[a-z0-9_]{2,60}$/).default("auth_otp") }).strict();

adminSmsRouter.post("/sms/test", can("channels.manage"), validate({ body: testBody }), async (req: Request, res: Response) => {
  ok(res, await sendTestSms(req.user!.id, req.valid!.body as z.infer<typeof testBody>));
});

const listQuery = z
  .object({
    status: z.enum(["queued", "sending", "sent", "delivered", "failed", "skipped"]).optional(),
    template: z.string().regex(/^[a-z0-9_]{2,60}$/).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

adminSmsRouter.get("/sms", can("campaigns.view"), validate({ query: listQuery }), async (req: Request, res: Response) => {
  const query = req.valid!.query as z.infer<typeof listQuery>;
  const { data, total } = await listSms(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});

adminSmsRouter.get("/sms/summary", can("campaigns.view"), async (_req: Request, res: Response) => {
  ok(res, await smsSummary());
});

const idParams = z.object({ id: z.string().uuid() });

adminSmsRouter.post("/sms/:id/resend", can("campaigns.send"), validate({ params: idParams }), async (req: Request, res: Response) => {
  ok(res, await resendSms((req.valid!.params as { id: string }).id));
});
