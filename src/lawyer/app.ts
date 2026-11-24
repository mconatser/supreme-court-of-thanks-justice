/** /lawyer: chat with counsel, live counsel's notes, predictions vs outcomes (lawyer passcode). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { clientIp, RateLimiter, requireRole } from "../shared/auth.ts";
import { Budget } from "../shared/budget.ts";
import type { Config } from "../shared/config.ts";
import { Gateway, type Fetch } from "../shared/gateway.ts";
import { createJev, type Jev } from "../shared/jev.ts";
import { createOllama, type Ollama } from "../shared/ollama.ts";
import { Lawyer, type LawyerContext } from "./agent.ts";
import { CourtClient } from "./court.ts";
import { openLawyerDb } from "./db.ts";
import { exParte } from "./exparte.ts";

export interface LawyerOverrides {
  dbPath?: string;
  /** How the lawyer reaches the court (tests route this into the court app in-process). */
  courtFetch?: Fetch;
  jev?: Jev;
  ollama?: Ollama;
  /** The lawyer's own gateway (tests inject one to simulate connector policies). */
  gateway?: Gateway;
  log?: (m: string) => void;
}

export function createLawyer(cfg: Config, o: LawyerOverrides = {}): { lawyer: Lawyer; ctx: LawyerContext; gateway: Gateway } {
  const log = o.log ?? ((m: string) => console.log(m));
  const db = openLawyerDb(o.dbPath ?? join(cfg.DATA_DIR, "lawyer.db"));
  // Its own budget counters (in MODE=all that's up to twice the daily limits across both apps).
  const budget = new Budget(db, { jev: cfg.JEV_DAILY, ollama: cfg.OLLAMA_DAILY, tts_chars: 0, email: 0 }, cfg.COURT_TZ);
  // Box, AgentMail and TTS overrides are only here for the ex parte demo to try (and be denied).
  const gateway =
    o.gateway ??
    new Gateway({
      mode: cfg.GATEWAY_MODE,
      listUrl: cfg.GATEWAY_LIST_URL,
      overrides: { typesafe: cfg.TYPESAFE_BASE, ollama: cfg.OLLAMA_BASE, box: cfg.BOX_BASE, agentmail: cfg.AGENTMAIL_BASE, elevenlabs_tts: cfg.ELEVENLABS_BASE },
      log,
    });
  const bus = new EventEmitter<{ update: [string] }>();
  bus.setMaxListeners(100);
  const ctx: LawyerContext = {
    cfg,
    db,
    jev: o.jev ?? createJev({ gateway, budget, model: cfg.JEV_MODEL, log }),
    ollama: o.ollama ?? createOllama({ gateway, budget, model: cfg.OLLAMA_MODEL }),
    court: new CourtClient(cfg.COURT_URL, cfg.COURT_TOKEN, o.courtFetch),
    bus,
    log,
  };
  return { lawyer: new Lawyer(ctx), ctx, gateway };
}

export function createLawyerApp(
  lawyer: Lawyer,
  ctx: LawyerContext,
  opts: { publicDir?: string; heartbeatMs?: number; streamMaxMs?: number; gateway?: Gateway; spriteName?: () => Promise<string | null> } = {},
) {
  const cfg = ctx.cfg;
  const publicDir = opts.publicDir ?? "public";
  const app = new Hono();
  const auth = requireRole(cfg, "lawyer");

  const notReady = () =>
    !lawyer.client ? "Counsel needs to know who their client is. Set LAWYER_CLIENT in .env to your court alias, then restart." : null;

  app.get("/", auth, (c) => c.html(readFileSync(`${publicDir}/lawyer.html`, "utf8")));

  app.get("/api/state", auth, (c) => {
    const problem = notReady();
    if (problem) return c.json({ error: problem }, 503);
    void lawyer.reconcile(); // throttled: record rulings that happened while nobody was watching
    return c.json(lawyer.view(lawyer.currentMatter()));
  });

  app.post("/api/message", auth, async (c) => {
    const problem = notReady();
    if (problem) return c.json({ error: problem }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; confirm?: unknown };
    const ref = lawyer.currentMatter();
    if (lawyer.isRunning(ref)) return c.json({ error: "Counsel is still working on your last message. Hang on!" }, 409);
    const text = typeof body.text === "string" ? body.text.slice(0, 2000) : undefined;
    const confirm = typeof body.confirm === "boolean" ? body.confirm : undefined;
    if (!text?.trim() && confirm === undefined) return c.json({ error: "Say something to your lawyer first." }, 400);
    void lawyer.handle(ref, { text, confirm });
    return c.json({ ok: true, matter: ref }, 202);
  });

  // The ex parte demo: a button for people, never a tool for the LLM.
  const exParteLimiter = new RateLimiter(10, 3600_000);
  app.post("/demo/ex-parte", auth, async (c) => {
    if (!opts.gateway) return c.json({ error: "The ex parte demo isn't wired up here." }, 503);
    if (!exParteLimiter.take(clientIp(c))) return c.json({ error: "The court has heard enough motions for now. Try again later." }, 429);
    const result = await exParte(cfg, opts.gateway, { sprite: opts.spriteName });
    ctx.log(`[lawyer] ex parte demo: ${result.attempts.map((a) => `${a.connector}=${a.verdict}`).join(", ")}`);
    return c.json(result);
  });

  app.post("/api/new", auth, (c) => {
    const ref = lawyer.currentMatter();
    if (lawyer.isRunning(ref)) return c.json({ error: "Counsel is busy. Try again in a moment." }, 409);
    return c.json(lawyer.view(lawyer.newMatter()));
  });

  // Tells the page "something changed, refetch". Heartbeats keep the stream (and Sprite) awake.
  app.get("/stream", auth, (c) => {
    c.header("X-Accel-Buffering", "no");
    const res = streamSSE(c, async (stream) => {
      let closed = false;
      let wake: (() => void) | null = null;
      let dirty = false;
      const onUpdate = () => {
        dirty = true;
        wake?.();
      };
      ctx.bus.on("update", onUpdate);
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const hb = setInterval(() => stream.write(": heartbeat\n\n").catch(() => {}), opts.heartbeatMs ?? 15_000);
      const deadline = Date.now() + (opts.streamMaxMs ?? 10 * 60_000);
      try {
        await stream.writeSSE({ event: "hello", data: "{}", retry: 3000 });
        while (!closed && Date.now() < deadline) {
          if (!dirty) {
            await new Promise<void>((r) => {
              const t = setTimeout(r, Math.max(0, deadline - Date.now()));
              wake = () => {
                clearTimeout(t);
                r();
              };
            });
            wake = null;
          }
          if (dirty && !closed) {
            dirty = false;
            await stream.writeSSE({ event: "update", data: "{}" });
          }
        }
        if (!closed) await stream.writeSSE({ event: "timeout", data: "{}" });
      } finally {
        clearInterval(hb);
        ctx.bus.off("update", onUpdate);
      }
    });
    res.headers.set("Cache-Control", "no-cache, no-transform");
    return res;
  });

  return app;
}
