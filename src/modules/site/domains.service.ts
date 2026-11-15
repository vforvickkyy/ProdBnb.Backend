import { ConflictError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../admin/audit.service";
import { getSiteSettings, isVercelConnected, setPrimaryDomainRow, vercelTarget } from "./integrations.service";
import { AddDomainInput } from "./site.schema";
import {
  addProjectDomain,
  getDomainConfig,
  listProjectDomains,
  removeProjectDomain,
  updateProjectDomain,
  verifyProjectDomain,
  VercelDomainConfig,
  VercelProjectDomain,
} from "./vercel";

/**
 * Website domains (Console 3), managed from the admin console through the website's Vercel
 * project. Vercel stays the source of truth for which domains exist and whether they are verified
 * and pointing at it; this backend only adds the DNS records the admin has to create, and keeps the
 * one setting Vercel doesn't have -- which domain is *primary* (canonical URLs, sitemaps, emails).
 */

export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  /** The host/name field as most DNS providers ask for it ("@" = the bare domain). */
  name: string;
  value: string;
  purpose: "point" | "verify";
}

export interface SiteDomain {
  name: string;
  apex_name: string;
  is_apex: boolean;
  /** *.vercel.app addresses Vercel gives every project -- always there, cannot be removed. */
  is_platform_domain: boolean;
  is_primary: boolean;
  verified: boolean;
  redirect_to: string | null;
  /** null = DNS not checked (e.g. Vercel did not answer for this domain). */
  configured: boolean | null;
  configured_by: string | null;
  /** What to set at the DNS provider. Empty once the domain is fully set up. */
  dns_records: DnsRecord[];
  status: "active" | "redirect" | "pending_dns" | "pending_verification";
}

export interface SiteDomainsOverview {
  vercel_connected: boolean;
  primary_domain: string | null;
  domains: SiteDomain[];
}

function subdomainLabel(name: string, apex: string): string {
  return name === apex ? "@" : name.slice(0, -(apex.length + 1));
}

export function describeDomain(domain: VercelProjectDomain, config: VercelDomainConfig | null, primary: string | null): SiteDomain {
  const isApex = domain.name === domain.apexName;
  const isPlatform = domain.name.endsWith(".vercel.app");
  const records: DnsRecord[] = [];

  if (!domain.verified) {
    for (const challenge of domain.verification ?? []) {
      if (challenge.type === "TXT") {
        records.push({ type: "TXT", name: subdomainLabel(challenge.domain, domain.apexName), value: challenge.value, purpose: "verify" });
      }
    }
  }
  if (!isPlatform && config?.misconfigured) {
    if (isApex) {
      const ip = [...config.recommendedIPv4].sort((a, b) => a.rank - b.rank)[0]?.value[0];
      if (ip) records.push({ type: "A", name: "@", value: ip, purpose: "point" });
    } else {
      const cname = [...config.recommendedCNAME].sort((a, b) => a.rank - b.rank)[0]?.value;
      if (cname) records.push({ type: "CNAME", name: subdomainLabel(domain.name, domain.apexName), value: cname.replace(/\.$/, ""), purpose: "point" });
    }
  }

  const configured = isPlatform ? true : config ? !config.misconfigured : null;
  const status: SiteDomain["status"] = !domain.verified
    ? "pending_verification"
    : configured === false
      ? "pending_dns"
      : domain.redirect
        ? "redirect"
        : "active";

  return {
    name: domain.name,
    apex_name: domain.apexName,
    is_apex: isApex,
    is_platform_domain: isPlatform,
    is_primary: primary === domain.name,
    verified: domain.verified,
    redirect_to: domain.redirect ?? null,
    configured,
    configured_by: config?.configuredBy ?? null,
    dns_records: records,
    status,
  };
}

export async function listSiteDomains(): Promise<SiteDomainsOverview> {
  const settings = await getSiteSettings();
  if (!(await isVercelConnected())) {
    return { vercel_connected: false, primary_domain: settings.primary_domain, domains: [] };
  }
  const target = await vercelTarget();
  const domains = await listProjectDomains(target);
  const described = await Promise.all(
    domains.map(async (domain) => {
      const config = domain.name.endsWith(".vercel.app") ? null : await getDomainConfig(target, domain.name).catch(() => null);
      return describeDomain(domain, config, settings.primary_domain);
    })
  );
  // Primary first, then custom domains, then the platform's own addresses.
  described.sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || Number(a.is_platform_domain) - Number(b.is_platform_domain) || a.name.localeCompare(b.name)
  );
  return { vercel_connected: true, primary_domain: settings.primary_domain, domains: described };
}

async function findDomain(name: string): Promise<SiteDomain> {
  const overview = await listSiteDomains();
  const domain = overview.domains.find((d) => d.name === name);
  if (!domain) throw new ValidationError(`${name} is not one of the website's domains.`);
  return domain;
}

export async function addSiteDomain(actorId: string, input: AddDomainInput): Promise<SiteDomain> {
  if (input.redirect_to && input.redirect_to === input.name) {
    throw new ValidationError("A domain cannot redirect to itself.");
  }
  const target = await vercelTarget();
  const added = await addProjectDomain(target, input.name, input.redirect_to ?? null);
  const settings = await getSiteSettings();
  await writeAuditLog(actorId, "ADMIN_ADDED_DOMAIN", "site", settings.id, null, { domain: input.name, redirect_to: input.redirect_to ?? null });
  const config = await getDomainConfig(target, added.name).catch(() => null);
  return describeDomain(added, config, settings.primary_domain);
}

export async function updateSiteDomain(actorId: string, name: string, redirectTo: string | null): Promise<SiteDomain> {
  const settings = await getSiteSettings();
  if (redirectTo && settings.primary_domain === name) {
    throw new ConflictError("The primary domain cannot redirect elsewhere. Make another domain primary first.");
  }
  if (redirectTo === name) throw new ValidationError("A domain cannot redirect to itself.");
  const target = await vercelTarget();
  const updated = await updateProjectDomain(target, name, redirectTo);
  await writeAuditLog(actorId, "ADMIN_UPDATED_DOMAIN", "site", settings.id, null, { domain: name, redirect_to: redirectTo });
  const config = await getDomainConfig(target, name).catch(() => null);
  return describeDomain(updated, config, settings.primary_domain);
}

export async function verifySiteDomain(name: string): Promise<SiteDomain> {
  const target = await vercelTarget();
  const settings = await getSiteSettings();
  // Vercel answers 400 while the TXT record is not visible yet -- report the state, not an error.
  const domain = await verifyProjectDomain(target, name).catch(async () => (await listProjectDomains(target)).find((d) => d.name === name));
  if (!domain) throw new ValidationError(`${name} is not one of the website's domains.`);
  const config = await getDomainConfig(target, name).catch(() => null);
  return describeDomain(domain, config, settings.primary_domain);
}

export async function removeSiteDomain(actorId: string, name: string): Promise<void> {
  const settings = await getSiteSettings();
  if (name.endsWith(".vercel.app")) {
    throw new ValidationError("The website's own .vercel.app address cannot be removed.");
  }
  if (settings.primary_domain === name) {
    throw new ConflictError("This is the primary domain. Make another domain primary before removing it.");
  }
  const target = await vercelTarget();
  await removeProjectDomain(target, name);
  await writeAuditLog(actorId, "ADMIN_REMOVED_DOMAIN", "site", settings.id, null, { domain: name });
}

export async function setPrimaryDomain(actorId: string, name: string | null): Promise<SiteDomainsOverview> {
  const before = await getSiteSettings();
  if (name) {
    const domain = await findDomain(name);
    if (!domain.verified || domain.configured === false) {
      throw new ConflictError(`${name} is not fully set up yet. Finish its DNS records, then make it primary.`);
    }
    if (domain.redirect_to) {
      throw new ConflictError(`${name} redirects to ${domain.redirect_to}. Remove the redirect, or make ${domain.redirect_to} primary.`);
    }
  }
  const after = await setPrimaryDomainRow(actorId, name);
  await writeAuditLog(actorId, "ADMIN_SET_PRIMARY_DOMAIN", "site", after.id, null, { from: before.primary_domain, to: name });
  return listSiteDomains();
}
