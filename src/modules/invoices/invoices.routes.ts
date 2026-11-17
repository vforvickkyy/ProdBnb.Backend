import { Request, Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { writeAuditLog } from "../admin/audit.service";
import { requirePermission as can } from "../admin/permissions";
import {
  invoiceIdParamSchema,
  invoicePreviewSchema,
  invoiceSettingsSchema,
  listInvoicesQuerySchema,
  listReceiptsQuerySchema,
  paymentIdParamSchema,
  sendSchema,
  type InvoiceSettingsInput,
  type ListInvoicesQuery,
  type ListReceiptsQuery,
  type SendInput,
} from "./invoices.schema";
import {
  emailReady,
  getInvoice,
  getInvoiceSettings,
  invoiceCounts,
  invoiceEvents,
  invoicePdf,
  issueMissingInvoices,
  listInvoices,
  listReceipts,
  missingSettings,
  myInvoice,
  myInvoices,
  previewPdf,
  receiptPdf,
  sendInvoice,
  sendPending,
  sendReceipt,
  updateInvoiceSettings,
  type InvoiceSettings,
} from "./invoices.service";

type IdParam = { id: string };

function sendPdf(res: Response, pdf: Uint8Array, filename: string, inline = false): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).end(Buffer.from(pdf));
}

const fileName = (number: string) => `${number.replace(/\//g, "-")}.pdf`;

// -- The booker's own invoices ----------------------------------------------------------------------

export const myInvoicesRouter = Router();
myInvoicesRouter.get("/me/invoices", requireAuth, async (req: Request, res: Response) => {
  ok(res, await myInvoices(req.user!.id));
});
myInvoicesRouter.get("/me/invoices/:id/pdf", requireAuth, validate({ params: invoiceIdParamSchema }), async (req: Request, res: Response) => {
  const invoice = await myInvoice(req.user!.id, (req.valid!.params as IdParam).id);
  sendPdf(res, await invoicePdf(invoice), fileName(invoice.number));
});

// -- Admin ---------------------------------------------------------------------------------------------

export const adminInvoicesRouter = Router();

adminInvoicesRouter.get("/invoice-settings", can("payments.view"), async (_req: Request, res: Response) => {
  const settings = await getInvoiceSettings();
  ok(res, { ...settings, missing: missingSettings(settings), email_connected: await emailReady() });
});
adminInvoicesRouter.patch("/invoice-settings", can("invoices.manage"), validate({ body: invoiceSettingsSchema }), async (req: Request, res: Response) => {
  const input = req.valid!.body as InvoiceSettingsInput;
  const settings = await updateInvoiceSettings(input as Partial<InvoiceSettings>, req.user!.id);
  await writeAuditLog(req.user!.id, "ADMIN_UPDATED_INVOICE_SETTINGS", "settings", settings.id, null, { fields: Object.keys(input) });
  ok(res, { ...settings, missing: missingSettings(settings), email_connected: await emailReady() });
});
/** A sample invoice with the saved template merged with unsaved edits from the editor. */
adminInvoicesRouter.post("/invoice-settings/preview", can("payments.view"), validate({ body: invoicePreviewSchema }), async (req: Request, res: Response) => {
  const saved = await getInvoiceSettings();
  const draft = { ...saved, ...(req.valid!.body as Partial<InvoiceSettings>) };
  sendPdf(res, await previewPdf(draft as InvoiceSettings), "invoice-preview.pdf", true);
});

adminInvoicesRouter.get("/invoices", can("payments.view"), validate({ query: listInvoicesQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as ListInvoicesQuery;
  const [{ data, total }, counts] = await Promise.all([listInvoices(query), invoiceCounts()]);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total, counts });
});
adminInvoicesRouter.get("/invoices/:id", can("payments.view"), validate({ params: invoiceIdParamSchema }), async (req: Request, res: Response) => {
  const id = (req.valid!.params as IdParam).id;
  const [invoice, events] = await Promise.all([getInvoice(id), invoiceEvents(id)]);
  ok(res, { ...invoice, events });
});
adminInvoicesRouter.get("/invoices/:id/pdf", can("payments.view"), validate({ params: invoiceIdParamSchema }), async (req: Request, res: Response) => {
  const invoice = await getInvoice((req.valid!.params as IdParam).id);
  sendPdf(res, await invoicePdf(invoice), fileName(invoice.number));
});
adminInvoicesRouter.post("/invoices/:id/send", can("invoices.manage"), validate({ params: invoiceIdParamSchema, body: sendSchema }), async (req: Request, res: Response) => {
  const id = (req.valid!.params as IdParam).id;
  const invoice = await sendInvoice(id, { via: "manual", to: (req.valid!.body as SendInput).to, actorId: req.user!.id });
  await writeAuditLog(req.user!.id, "ADMIN_SENT_INVOICE", "invoice", id, null, { number: invoice.number, to: invoice.sent_to });
  ok(res, invoice);
});
/** Issues invoices for paid bookings that don't have one yet (e.g. paid before the template was filled). */
adminInvoicesRouter.post("/invoices/issue-missing", can("invoices.manage"), async (req: Request, res: Response) => {
  const result = await issueMissingInvoices();
  await writeAuditLog(req.user!.id, "ADMIN_ISSUED_INVOICES", "settings", (await getInvoiceSettings()).id, null, result);
  ok(res, result);
});
adminInvoicesRouter.post("/invoices/send-pending", can("invoices.manage"), async (req: Request, res: Response) => {
  const result = await sendPending(req.user!.id);
  await writeAuditLog(req.user!.id, "ADMIN_SENT_INVOICE", "settings", (await getInvoiceSettings()).id, null, { bulk: true, ...result });
  ok(res, result);
});

adminInvoicesRouter.get("/receipts", can("payments.view"), validate({ query: listReceiptsQuerySchema }), async (req: Request, res: Response) => {
  const query = req.valid!.query as ListReceiptsQuery;
  const { data, total } = await listReceipts(query);
  ok(res, data, 200, { page: query.page, pageSize: query.pageSize, total });
});
adminInvoicesRouter.get("/receipts/:id/pdf", can("payments.view"), validate({ params: paymentIdParamSchema }), async (req: Request, res: Response) => {
  const receipt = await receiptPdf((req.valid!.params as IdParam).id);
  sendPdf(res, receipt.pdf, receipt.filename);
});
adminInvoicesRouter.post("/receipts/:id/send", can("invoices.manage"), validate({ params: paymentIdParamSchema, body: sendSchema }), async (req: Request, res: Response) => {
  const id = (req.valid!.params as IdParam).id;
  const result = await sendReceipt(id, { to: (req.valid!.body as SendInput).to, actorId: req.user!.id });
  await writeAuditLog(req.user!.id, "ADMIN_SENT_RECEIPT", "payment", id, null, result);
  ok(res, result);
});
