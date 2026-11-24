/**
 * Passcode sessions (signed cookie), the COURT_TOKEN check for lawyer→court calls, and a
 * small in-memory rate limiter. The Sprite URL is public, so every non-public route is behind one
 * of these.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";

export type Role = "court" | "parent" | "lawyer";
const COOKIE = "fc_session";
const SESSION_DAYS = 30;

export interface AuthConfig {
  COURT_PASSCODE: string;
  PARENT_PASSCODE: string;
  LAWYER_PASSCODE: string;
  SESSION_SECRET: string;
  COURT_TOKEN: string;
}

/** Constant-time string comparison (hash first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Which roles a passcode unlocks. The parent passcode also opens the court. */
export function rolesForPasscode(cfg: AuthConfig, passcode: string): Role[] {
  const p = passcode.trim();
  if (!p) return [];
  if (safeEqual(p, cfg.PARENT_PASSCODE)) return ["parent", "court"];
  if (safeEqual(p, cfg.COURT_PASSCODE)) return ["court"];
  if (safeEqual(p, cfg.LAWYER_PASSCODE)) return ["lawyer"];
  return [];
}

export async function getRoles(c: Context, cfg: AuthConfig): Promise<Role[]> {
  const raw = await getSignedCookie(c, cfg.SESSION_SECRET, COOKIE);
  if (!raw) return [];
  try {
    const s = JSON.parse(raw) as { roles: Role[]; exp: number };
    if (typeof s.exp !== "number" || s.exp < Date.now()) return [];
    return Array.isArray(s.roles) ? s.roles : [];
  } catch {
    return [];
  }
}

export async function startSession(c: Context, cfg: AuthConfig, roles: Role[]) {
  const existing = await getRoles(c, cfg);
  const merged = [...new Set([...existing, ...roles])];
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  await setSignedCookie(c, COOKIE, JSON.stringify({ roles: merged, exp }), cfg.SESSION_SECRET, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return merged;
}

export function endSession(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

const wantsHtml = (c: Context) => c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");

/** Requires a session with `role`. HTML pages redirect to /login; everything else gets 401. */
export function requireRole(cfg: AuthConfig, role: Role): MiddlewareHandler {
  return async (c, next) => {
    const roles = await getRoles(c, cfg);
    if (roles.includes(role)) return next();
    if (roles.length && role === "parent") return c.json({ error: "Only a parent can do that." }, 403);
    if (wantsHtml(c)) {
      const nextUrl = encodeURIComponent(new URL(c.req.url).pathname);
      return c.redirect(`/login?role=${role}&next=${nextUrl}`);
    }
    return c.json({ error: "Please enter the passcode first." }, 401);
  };
}

export function hasCourtToken(c: Context, cfg: AuthConfig): boolean {
  const t = c.req.header("x-court-token") ?? "";
  return t !== "" && safeEqual(t, cfg.COURT_TOKEN);
}

export function requireCourtToken(cfg: AuthConfig): MiddlewareHandler {
  return async (c, next) => (hasCourtToken(c, cfg) ? next() : c.json({ error: "Court token required." }, 401));
}

/** COURT_TOKEN or a court session. */
export function requireTokenOrRole(cfg: AuthConfig, role: Role): MiddlewareHandler {
  const roleCheck = requireRole(cfg, role);
  return async (c, next) => (hasCourtToken(c, cfg) ? next() : roleCheck(c, next));
}

export function clientIp(c: Context): string {
  const fwd = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0];
  if (fwd?.trim()) return fwd.trim();
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/** Sliding-window limiter, in memory (one court process). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; returns false if the key is over the limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}
