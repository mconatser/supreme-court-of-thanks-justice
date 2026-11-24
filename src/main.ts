import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createCourtApp } from "./court/app.ts";
import { createCourtContext } from "./court/context.ts";
import { createLawyer, createLawyerApp } from "./lawyer/app.ts";
import { ConfigError, loadConfig } from "./shared/config.ts";
import { rolesForPasscode, startSession } from "./shared/auth.ts";
import { loadPeople, PeopleError } from "./shared/people.ts";

const bootedAt = Date.now();

function fail(err: unknown): never {
  if (err instanceof ConfigError || err instanceof PeopleError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

let cfg, people;
try {
  cfg = loadConfig();
  people = loadPeople(cfg.PEOPLE_FILE);
} catch (err) {
  fail(err);
}

const app = new Hono();
const runsCourt = cfg.MODE === "all" || cfg.MODE === "court";
const runsLawyer = cfg.MODE === "all" || cfg.MODE === "lawyer";

// The lawyer only talks to the court over HTTP (COURT_URL), even when both run in this process.
const lawyer = runsLawyer ? createLawyer(cfg) : null;
if (lawyer) app.route("/lawyer", createLawyerApp(lawyer.lawyer, lawyer.ctx));

const ctx = runsCourt ? createCourtContext(cfg, people) : null;
if (ctx) app.route("/", createCourtApp(ctx));
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

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`[main] listening on port ${info.port} (MODE=${cfg.MODE}, GATEWAY_MODE=${cfg.GATEWAY_MODE})`);
  if (ctx) {
    console.log(`[court] ${ctx.cast.court} is in session`);
    void ctx.familyCode.refresh(true).then(() => console.log(`[court] Family Code from ${ctx.familyCode.where.source}`));
    const resumed = ctx.hearings.resumeOpen();
    if (resumed.length) console.log(`[court] resuming ${resumed.length} open hearing(s)`);
    void ctx.hearings.retryRecords().then((n) => n && console.log(`[court] filed ${n} missing record(s) in Box`));
  }
  if (lawyer) {
    console.log(`[lawyer] counsel is in (client: ${cfg.LAWYER_CLIENT ? "set" : "NOT SET: add LAWYER_CLIENT to .env"}; court at ${cfg.COURT_URL})`);
    // Give the court a moment to start listening before resuming turns that call it.
    setTimeout(() => {
      const resumed = lawyer.lawyer.resumeRunning();
      if (resumed.length) console.log(`[lawyer] resuming ${resumed.length} interrupted turn(s)`);
    }, 1500).unref();
  }
});

const shutdown = () => {
  server.close();
  ctx?.db.close();
  lawyer?.ctx.db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
