import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createCourtApp } from "./court/app.ts";
import { createCourtContext } from "./court/context.ts";
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
  people = loadPeople(cfg.PEOPLE_FILE);
} catch (err) {
  fail(err);
}

if (cfg.MODE === "lawyer") {
  console.error("The lawyer app arrives in Phase 2. Use MODE=all or MODE=court for now.");
  process.exit(1);
}

const ctx = createCourtContext(cfg, people);
const app = new Hono();
app.route("/", createCourtApp(ctx));

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`[court] ${ctx.cast.court} is in session on port ${info.port} (MODE=${cfg.MODE}, GATEWAY_MODE=${cfg.GATEWAY_MODE})`);
  const resumed = ctx.hearings.resumeOpen();
  if (resumed.length) console.log(`[court] resuming ${resumed.length} open hearing(s)`);
});

const shutdown = () => {
  server.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
