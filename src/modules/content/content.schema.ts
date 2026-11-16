import { z } from "zod";

/**
 * Website pages and SEO -- request schemas.
 *
 * Pages are the website's editable text pages (About, Privacy, Terms...). SEO overrides replace the
 * title / description / share image the website would otherwise write automatically.
 */

const uuid = z.string().uuid();

/**
 * Slugs the website already uses for its own routes. A page cannot take one of these: it would be
 * unreachable (static routes win) or would shadow a real page.
 */
export const RESERVED_PAGE_SLUGS = [
  "search",
  "locations",
  "collections",
  "shoots",
  "login",
  "signup",
  "auth",
  "account",
  "host",
  "api",
  "sitemap.xml",
  "robots.txt",
  "manifest.webmanifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "home",
  "bookings",
  "messages",
  "admin",
] as const;

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case letters, numbers and single hyphens, e.g. refund-policy.")
  .refine((slug) => !(RESERVED_PAGE_SLUGS as readonly string[]).includes(slug), {
    message: "That address is used by the website itself. Choose another.",
  });

export const pagePlacementSchema = z.enum(["company", "legal", "hidden"]);
export type PagePlacement = z.infer<typeof pagePlacementSchema>;

const pageTitle = z.string().trim().min(1).max(120);
const pageBody = z.string().max(100_000);
const reason = z.string().trim().min(1).max(500).optional();

export const createPageSchema = z
  .object({
    slug: pageSlugSchema,
    title: pageTitle,
    body: pageBody.default(""),
    placement: pagePlacementSchema.default("legal"),
    position: z.number().int().min(0).max(10_000).optional(),
    is_published: z.boolean().default(false),
    reason,
  })
  .strict();
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z
  .object({
    slug: pageSlugSchema.optional(),
    title: pageTitle.optional(),
    body: pageBody.optional(),
    placement: pagePlacementSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    is_published: z.boolean().optional(),
    /** Turn off once someone (ideally a lawyer, for policies) has reviewed the text. */
    needs_review: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== "reason"), { message: "Nothing to update." });
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const pageIdParamSchema = z.object({ id: uuid });
export type PageIdParam = z.infer<typeof pageIdParamSchema>;

export const publicPageParamSchema = z.object({ slug: z.string().trim().toLowerCase().min(1).max(80) });
export type PublicPageParam = z.infer<typeof publicPageParamSchema>;

// SEO --------------------------------------------------------------------------------------------

export const seoEntityTypeSchema = z.enum(["page", "location", "collection", "use_case", "category"]);
export type SeoEntityType = z.infer<typeof seoEntityTypeSchema>;

/**
 * Website pages that are not editable text pages but still take SEO overrides. Editable pages are
 * keyed by their slug; everything else (listings, collections, use cases, categories) by id.
 */
export const BUILT_IN_SEO_PAGES = ["home", "host", "shoots"] as const;

export const seoKeyParamSchema = z
  .object({ type: seoEntityTypeSchema, key: z.string().trim().toLowerCase().min(1).max(80) })
  .superRefine((value, ctx) => {
    const ok =
      value.type === "page" ? /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.key) : uuid.safeParse(value.key).success;
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: value.type === "page" ? "Unknown page." : `Expected the ${value.type.replace("_", " ")}'s id.`,
      });
    }
  });
export type SeoKeyParam = z.infer<typeof seoKeyParamSchema>;

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().min(1).max(max).nullable());

export const saveSeoSchema = z
  .object({
    /** Search-result title. ~60 characters show in Google; null = written automatically. */
    meta_title: optionalText(120).optional(),
    /** Search-result snippet. ~155 characters show; null = written automatically. */
    meta_description: optionalText(320).optional(),
    /** Image shown when the page is shared. Must be https; null = the page's own photo. */
    og_image_url: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : v),
        z.string().trim().url().max(1000).startsWith("https://", "Use an https:// image address.").nullable()
      )
      .optional(),
    /** Ask search engines not to list this page. */
    noindex: z.boolean().optional(),
    reason,
  })
  .strict();
export type SaveSeoInput = z.infer<typeof saveSeoSchema>;

export const listSeoQuerySchema = z.object({ type: seoEntityTypeSchema.optional() }).strict();
export type ListSeoQuery = z.infer<typeof listSeoQuerySchema>;

// Website contact email ----------------------------------------------------------------------------

export const siteContactSchema = z
  .object({
    support_email: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().toLowerCase().email("Enter an email address like help@example.com.").max(254).nullable()
    ),
    reason,
  })
  .strict();
export type SiteContactInput = z.infer<typeof siteContactSchema>;
