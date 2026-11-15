import { AppError } from "../../errors/AppError";

/**
 * A minimal client for the Vercel REST API (https://vercel.com/docs/rest-api), used only to manage
 * the public website's domains from the admin console. Every call is scoped to one project (and
 * team, when the project belongs to a team).
 */
export interface VercelTarget {
  token: string;
  projectId: string;
  teamId: string | null;
}

export interface VercelProjectDomain {
  name: string;
  apexName: string;
  verified: boolean;
  redirect: string | null;
  redirectStatusCode: number | null;
  gitBranch: string | null;
  verification?: { type: string; domain: string; value: string; reason: string }[];
  createdAt?: number;
  updatedAt?: number;
}

export interface VercelDomainConfig {
  configuredBy: "A" | "CNAME" | "http" | "dns-01" | null;
  misconfigured: boolean;
  recommendedIPv4: { rank: number; value: string[] }[];
  recommendedCNAME: { rank: number; value: string }[];
  acceptedChallenges?: string[];
}

const API = "https://api.vercel.com";

async function call<T>(target: VercelTarget, method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API}${path}`);
  if (target.teamId) url.searchParams.set("teamId", target.teamId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!res.ok) {
    const message = json?.error?.message ?? `Vercel answered ${res.status}.`;
    // Pass Vercel's own explanation through (e.g. "domain already in use by another project");
    // a bad token or missing access is the admin's to fix, not a server fault.
    if (res.status === 401 || res.status === 403) {
      throw new AppError(400, "VALIDATION_ERROR", `Vercel refused the request: ${message} Check the token's access to this project.`);
    }
    if (res.status === 404) throw new AppError(404, "NOT_FOUND", `Vercel: ${message}`);
    if (res.status === 409) throw new AppError(409, "CONFLICT", `Vercel: ${message}`);
    if (res.status === 400) throw new AppError(400, "VALIDATION_ERROR", `Vercel: ${message}`);
    throw new AppError(502, "INTERNAL_ERROR", `Vercel is not responding as expected (${res.status}). Try again in a minute.`);
  }
  return json as T;
}

export function getProject(target: VercelTarget) {
  return call<{ id: string; name: string; framework: string | null }>(target, "GET", `/v9/projects/${encodeURIComponent(target.projectId)}`);
}

export async function listProjectDomains(target: VercelTarget): Promise<VercelProjectDomain[]> {
  const res = await call<{ domains: VercelProjectDomain[] }>(target, "GET", `/v9/projects/${encodeURIComponent(target.projectId)}/domains`, undefined, {
    limit: "100",
  });
  return res.domains ?? [];
}

export function getDomainConfig(target: VercelTarget, domain: string) {
  return call<VercelDomainConfig>(target, "GET", `/v6/domains/${encodeURIComponent(domain)}/config`, undefined, { projectIdOrName: target.projectId });
}

export function addProjectDomain(target: VercelTarget, name: string, redirect: string | null) {
  return call<VercelProjectDomain>(target, "POST", `/v10/projects/${encodeURIComponent(target.projectId)}/domains`, {
    name,
    ...(redirect ? { redirect, redirectStatusCode: 308 } : {}),
  });
}

export function updateProjectDomain(target: VercelTarget, name: string, redirect: string | null) {
  return call<VercelProjectDomain>(target, "PATCH", `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(name)}`, {
    redirect,
    redirectStatusCode: redirect ? 308 : null,
  });
}

export function verifyProjectDomain(target: VercelTarget, name: string) {
  return call<VercelProjectDomain>(target, "POST", `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(name)}/verify`);
}

export function removeProjectDomain(target: VercelTarget, name: string) {
  return call<Record<string, never>>(target, "DELETE", `/v9/projects/${encodeURIComponent(target.projectId)}/domains/${encodeURIComponent(name)}`);
}
