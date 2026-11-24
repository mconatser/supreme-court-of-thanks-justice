/**
 * Assembles the HTTP app for a MODE: all (court + lawyer), court (courthouse only; /lawyer
 * redirects to LAWYER_URL), or lawyer (counsel only, with its own login). Used by main.ts and tests.
 */
import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createCourtApp } from "./court/app.ts";
import { createCourtContext, type ContextOverrides, type CourtContext } from "./court/context.ts";
import { createLawyer, createLawyerApp, type LawyerOverrides } from "./lawyer/app.ts";
import { rolesForPasscode, startSession } from "./shared/auth.ts";
import type { Config } from "./shared/config.ts";
import type { Person } from "./shared/people.ts";

export interface BuiltApp {
  app: Hono;
  court: CourtContext | null;
  lawyer: ReturnType<typeof createLawyer> | null;
}

export function buildApp(cfg: Config, people: Person[], o: { court?: ContextOverrides; lawyer?: LawyerOverrides } = {}): BuiltApp {
  const bootedAt = Date.now();
  const app = new Hono();
  const runsCourt = cfg.MODE === "all" || cfg.MODE === "court";
  const runsLawyer = cfg.MODE === "all" || cfg.MODE === "lawyer";

  // The lawyer only talks to the court over HTTP (COURT_URL), even when both run in this process.
  const lawyer = runsLawyer ? createLawyer(cfg, o.lawyer) : null;
  if (lawyer) app.route("/lawyer", createLawyerApp(lawyer.lawyer, lawyer.ctx, { gateway: lawyer.gateway }));
  else if (cfg.LAWYER_URL) {
    // Courthouse-only Sprite: counsel lives on its own Sprite now.
    const to = cfg.LAWYER_URL.replace(/\/+$/, "");
    app.all("/lawyer", (c) => c.redirect(`${to}/lawyer`, 302));
    app.all("/lawyer/*", (c) => c.redirect(`${to}${new URL(c.req.url).pathname}`, 302));
  }

  const court = runsCourt ? createCourtContext(cfg, people, o.court) : null;
  if (court) app.route("/", createCourtApp(court));
  else {
    // Lawyer-only Sprite: its own passcode login and the shared static files.
    app.get("/", (c) => c.redirect("/lawyer"));
    app.get("/login", (c) => c.html(readFileSync("public/login.html", "utf8")));
    app.post("/login", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { passcode?: unknown };
      const roles = rolesForPasscode(cfg, String(body.passcode ?? "")).filter((r) => r === "lawyer");
      if (!roles.length) return c.json({ error: "That passcode isn't right. Try again!" }, 401);
      return c.json({ ok: true, roles: await startSession(c, cfg, roles) });
    });
    for (const dir of ["css", "js", "sfx"]) app.use(`/${dir}/*`, serveStatic({ root: "public" }));
    app.get("/healthz", (c) => c.json({ ok: true, bootedAt, uptimeMs: Date.now() - bootedAt, deployId: null }));
  }
  return { app, court, lawyer };
}
