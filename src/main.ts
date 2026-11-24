import { serve } from "@hono/node-server";
import { buildApp } from "./server.ts";
import { ConfigError, loadConfig } from "./shared/config.ts";
import { loadPeople, PeopleError } from "./shared/people.ts";

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
  // The lawyer gets the party list from the court, so a lawyer-only Sprite has no people.json.
  people = cfg.MODE === "lawyer" ? [] : loadPeople(cfg.PEOPLE_FILE);
} catch (err) {
  fail(err);
}

const { app, court: ctx, lawyer } = buildApp(cfg, people);

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`[main] listening on port ${info.port} (MODE=${cfg.MODE}, GATEWAY_MODE=${cfg.GATEWAY_MODE})`);
  if (!lawyer) console.log(`[main] no lawyer here; /lawyer ${cfg.LAWYER_URL ? `redirects to ${cfg.LAWYER_URL}` : "is not served (set LAWYER_URL to redirect)"}`);
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
      void lawyer.lawyer.reconcile(true).then((r) => {
        if (r.settled || r.following) console.log(`[lawyer] reconciled: ${r.settled} ruling(s) recorded, following ${r.following} hearing(s)`);
      });
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
