import { z } from "zod";

/**
 * Website (Console 3) -- request schemas for the public site's settings, integrations and domains.
 */

/** Lower-case DNS hostname with at least one dot, e.g. "example.com" or "www.example.in". */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Enter a domain like example.com or www.example.com.");

export const siteProviderSchema = z.enum(["google_maps", "vercel"]);
export type SiteProvider = z.infer<typeof siteProviderSchema>;
export const siteProviderParamSchema = z.object({ provider: siteProviderSchema });
export type SiteProviderParam = z.infer<typeof siteProviderParamSchema>;

/**
 * Google Maps. The browser key is public by design (every visitor's browser receives it), so it is
 * stored as configuration and returned by GET /v1/site-config; it must be restricted to the site's
 * domains in Google Cloud. The optional server key is a secret (Vault) for backend geocoding.
 */
export const googleMapsKey = z
  .string()
  .trim()
  .regex(/^AIza[0-9A-Za-z_-]{35}$/, "That doesn't look like a Google Maps API key (they start with AIza and are 39 characters).");

export const saveGoogleMapsSchema = z
  .object({
    browser_key: googleMapsKey,
    map_id: z.string().trim().min(1).max(100).nullable().optional(),
    /** Omit to keep the stored server key; send a new one to replace it. */
    server_key: googleMapsKey.optional(),
  })
  .strict();
export type SaveGoogleMapsInput = z.infer<typeof saveGoogleMapsSchema>;

/** Vercel -- the website's project; the token is only ever used by the backend to manage domains. */
export const saveVercelSchema = z
  .object({
    project_id: z.string().trim().min(1).max(100),
    team_id: z.string().trim().min(1).max(100).nullable().optional(),
    /** Required the first time; omit afterwards to keep the stored token. */
    token: z.string().trim().min(20).max(200).optional(),
  })
  .strict();
export type SaveVercelInput = z.infer<typeof saveVercelSchema>;

export const addDomainSchema = z
  .object({
    name: hostnameSchema,
    /** Send visitors of this domain to another domain of the site (e.g. www → apex). */
    redirect_to: hostnameSchema.nullable().optional(),
  })
  .strict();
export type AddDomainInput = z.infer<typeof addDomainSchema>;

export const domainParamSchema = z.object({ domain: hostnameSchema });
export type DomainParam = z.infer<typeof domainParamSchema>;

export const updateDomainSchema = z.object({ redirect_to: hostnameSchema.nullable() }).strict();
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;

export const primaryDomainSchema = z.object({ domain: hostnameSchema.nullable() }).strict();
export type PrimaryDomainInput = z.infer<typeof primaryDomainSchema>;
