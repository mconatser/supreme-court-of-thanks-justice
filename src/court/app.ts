import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  clientIp,
  endSession,
  getRoles,
  RateLimiter,
  requireCourtToken,
  requireRole,
  requireTokenOrRole,
  rolesForPasscode,
  startSession,
} from "../shared/auth.ts";
import type { CourtContext } from "./context.ts";
import { linkParties, FINAL_STATUSES, OPEN_STATUSES, type EventRow } from "./db.ts";
import { labelsFor } from "./labels.ts";
import { loadPeople, PeopleError, publicParty } from "../shared/people.ts";
import { landmarkAsPrecedent } from "./landmarks.ts";
import { AppealError, ApprovalError, RemarkError, SummonsError } from "./hearing.ts";
import { MistrialError } from "./mistrial.ts";
import { caseLabel } from "./precedent.ts";
import { findPrecedent } from "./precedent.ts";
import { caseView, docketView, publicEvent } from "./views.ts";

export const LIMITS = { filing: 1500, relief: 300, title: 120, testimony: 1000 };
export const RECESS_MESSAGE = "Court is in recess until tomorrow.";

export interface CourtAppOptions {
  publicDir?: string;
  heartbeatMs?: number;
  streamMaxMs?: number;
  filingsPerHour?: number;
}

const FilingForm = z.object({
  plaintiff: z.string().trim().min(1, "Who is bringing the case?"),
  defendant: z.string().trim().min(1, "Who is the case against?"),
  title: z.string().trim().max(LIMITS.title, `Keep the title under ${LIMITS.title} characters.`).optional(),
  claim: z.string().trim().min(5, "Tell the court what happened.").max(LIMITS.filing, `Keep it under ${LIMITS.filing} characters.`),
  relief: z.string().trim().min(2, "Tell the court what you want.").max(LIMITS.relief, `Keep what you want under ${LIMITS.relief} characters.`),
  response: z.string().trim().max(LIMITS.filing, `Keep the other side under ${LIMITS.filing} characters.`).optional(),
});

const LawyerFiling = z.object({
  plaintiff: z.string().trim().min(1),
  defendant: z.string().trim().min(1),
  title: z.string().trim().max(LIMITS.title).optional(),
  claim: z.string().trim().min(5).max(LIMITS.filing),
  relief: z.string().trim().min(2).max(LIMITS.relief),
  argument: z.string().trim().max(LIMITS.filing).optional(),
});

export function createCourtApp(ctx: CourtContext, opts: CourtAppOptions = {}) {
  const cfg = ctx.cfg;
  const publicDir = opts.publicDir ?? "public";
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const streamMaxMs = opts.streamMaxMs ?? 10 * 60_000;
  const filingLimiter = new RateLimiter(opts.filingsPerHour ?? 10, 3600_000);
  const loginLimiter = new RateLimiter(20, 10 * 60_000);
  const summonsLimiter = new RateLimiter(20, 3600_000);
  const court = requireRole(cfg, "court");
  const parent = requireRole(cfg, "parent");
  const app = new Hono();

  const page = (name: string) => (c: Context) => c.html(readFileSync(`${publicDir}/${name}`, "utf8"));
  const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "Something in the form isn't right.";
  const findParty = (name: string) => ctx.people.find((p) => p.alias.toLowerCase() === name.trim().toLowerCase());

  app.onError((err, c) => {
    ctx.log(`[court] ${c.req.method} ${new URL(c.req.url).pathname}: ${err.stack ?? err}`);
    return c.json({ error: "Oops! The court tripped over its robe. Please try again." }, 500);
  });

  // ---------- public ----------

  // uptimeMs lets the page tell a cold wake from a warm one without trusting the phone's clock.
  app.get("/healthz", (c) => c.json({ ok: true, bootedAt: ctx.bootedAt, uptimeMs: Date.now() - ctx.bootedAt, deployId: ctx.deployId }));

  app.get("/login", page("login.html"));
  app.post("/login", async (c) => {
    if (!loginLimiter.take(clientIp(c))) return c.json({ error: "Too many tries. Take a breather and try again in a few minutes." }, 429);
    const body = await c.req.json().catch(() => ({}));
    const roles = rolesForPasscode(cfg, String((body as { passcode?: unknown }).passcode ?? ""));
    if (!roles.length) return c.json({ error: "That passcode isn't right. Try again!" }, 401);
    const all = await startSession(c, cfg, roles);
    return c.json({ ok: true, roles: all });
  });
  app.post("/logout", (c) => {
    endSession(c);
    return c.json({ ok: true });
  });

  // ---------- summons (token only: the person summoned may not have the court passcode) ----------

  const TOKEN = "{[A-Za-z0-9_-]{20,100}}";
  app.get(`/summons/:token${TOKEN}`, page("summons.html"));

  app.get(`/api/summons/:token${TOKEN}`, (c) => {
    const s = ctx.hearings.summonsByToken(c.req.param("token"));
    if (!s) return c.json({ error: "The court can't find that summons." }, 404);
    const k = ctx.hearings.getCase(s.case_id)!;
    const L = labelsFor(ctx.people, k);
    const you = ctx.people.find((p) => p.id === s.person_id)?.alias ?? "Witness";
    return c.json({
      status: s.status,
      you,
      caseLabel: caseLabel(k.number),
      title: L.relabel(k.title),
      otherParty: s.person_id === k.plaintiff_id ? L.defendant : L.plaintiff,
      claim: k.claim,
      relief: k.relief,
      maxLength: LIMITS.testimony,
      court: ctx.cast.court,
    });
  });

  app.post(`/summons/:token${TOKEN}`, async (c) => {
    if (!summonsLimiter.take(clientIp(c))) return c.json({ error: "That's a lot of answers! Please wait a bit and try again." }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { testimony?: unknown };
    const testimony = String(body.testimony ?? "").trim();
    if (testimony.length < 2) return c.json({ error: "Tell the court your side first." }, 400);
    if (testimony.length > LIMITS.testimony) return c.json({ error: `Keep it under ${LIMITS.testimony} characters.` }, 400);
    try {
      const { caseNumber } = ctx.hearings.answerSummons(c.req.param("token"), testimony);
      return c.json({ ok: true, caseNumber });
    } catch (err) {
      if (err instanceof SummonsError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.use("/css/*", serveStatic({ root: publicDir }));
  app.use("/js/*", serveStatic({ root: publicDir }));
  app.use("/sfx/*", serveStatic({ root: publicDir }));

  // ---------- court passcode ----------

  app.get("/", court, page("index.html"));
  app.get("/file", court, page("file.html"));
  app.get("/cases/:n{[0-9]+}", court, page("case.html"));

  app.get("/api/docket", court, async (c) => c.json(docketView(ctx, await getRoles(c, cfg))));

  app.get("/api/cases/:n{[0-9]+}", requireTokenOrRole(cfg, "court"), async (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    return c.json(caseView(k, ctx, await getRoles(c, cfg)));
  });

  app.get("/cases/:n{[0-9]+}/verdict.mp3", court, (c) => {
    const n = Number(c.req.param("n"));
    const round = c.req.query("round") === "1" ? 1 : 0;
    if (!ctx.voice.hasAudio(n, round)) return c.json({ error: "The judge hasn't recorded this verdict." }, 404);
    const bytes = readFileSync(ctx.voice.audioPath(n, round));
    return c.body(bytes, 200, { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400", "content-length": String(bytes.length) });
  });

  app.post("/cases/:n{[0-9]+}/appeal", court, async (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    if (!ctx.budget.canAfford({ jev: 3 })) return c.json({ error: RECESS_MESSAGE }, 503);
    if (!filingLimiter.take(clientIp(c))) return c.json({ error: "Whoa, that's a lot of filings! Try again later." }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { party?: unknown; evidence?: unknown };
    const evidence = String(body.evidence ?? "").trim();
    if (evidence.length < 5) return c.json({ error: "An appeal needs new evidence. What's new?" }, 400);
    if (evidence.length > LIMITS.filing) return c.json({ error: `Keep it under ${LIMITS.filing} characters.` }, 400);
    try {
      ctx.hearings.fileAppeal(k.id, String(body.party ?? ""), evidence);
    } catch (err) {
      if (err instanceof AppealError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json({ ok: true, url: `/cases/${k.number}` }, 201);
  });

  app.post("/cases/:n{[0-9]+}/mistrial", parent, async (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    try {
      const { delayMs } = await ctx.hearings.declareMistrial(k.id);
      return c.json({ ok: true, rewindInMs: delayMs, message: "Mistrial declared. Rewinding time…" }, 202);
    } catch (err) {
      if (err instanceof MistrialError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.post("/cases/:n{[0-9]+}/approval", parent, async (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    const decision = ((await c.req.json().catch(() => ({}))) as { decision?: string }).decision;
    if (decision !== "approve" && decision !== "deny") return c.json({ error: "Choose approve or deny." }, 400);
    try {
      await ctx.hearings.decidePetition(k.id, decision);
    } catch (err) {
      if (err instanceof ApprovalError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json(caseView(ctx.hearings.getCase(k.id)!, ctx, await getRoles(c, cfg)));
  });

  app.post("/file", court, async (c) => {
    if (!ctx.budget.inSession()) return c.json({ error: RECESS_MESSAGE }, 503);
    if (!filingLimiter.take(clientIp(c))) {
      return c.json({ error: "Whoa, that's a lot of cases! The court can take 10 an hour. Try again later." }, 429);
    }
    const parsed = FilingForm.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const f = parsed.data;
    const p = findParty(f.plaintiff);
    const d = findParty(f.defendant);
    if (!p || !d) return c.json({ error: "Pick both people from the list." }, 400);
    if (p.id === d.id) return c.json({ error: "You can't take yourself to court! Pick someone else." }, 400);

    const { id, number } = ctx.hearings.file({
      plaintiff: p.alias,
      defendant: d.alias,
      title: f.title,
      claim: f.claim,
      relief: f.relief,
      filedBy: "pro_se",
      filings: f.response ? [{ author: d.alias, kind: "response", body: f.response }] : [],
    });
    void ctx.hearings.start(id);
    return c.json({ number, url: `/cases/${number}` }, 201);
  });

  app.get("/cases/:n{[0-9]+}/stream", requireTokenOrRole(cfg, "court"), (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;

    // Keep proxies from buffering the stream; heartbeats keep it (and the Sprite) awake.
    c.header("X-Accel-Buffering", "no");

    const res = streamSSE(c, async (stream) => {
      let lastSent = after;
      let closed = false;
      let done = false;
      const queue: EventRow[] = [];
      let wake: (() => void) | null = null;
      const onEvent = (e: EventRow) => {
        if (e.case_id !== k.id) return;
        queue.push(e);
        wake?.();
      };
      ctx.bus.on("event", onEvent);
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const heartbeat = setInterval(() => {
        stream.write(": heartbeat\n\n").catch(() => {});
      }, heartbeatMs);

      // A case is done when it closes AND it's final now: a replayed case.closed must not end the
      // stream of a case whose appeal is still being heard.
      const isFinal = () => FINAL_STATUSES.has(ctx.hearings.getCase(k.id)!.status);
      const send = async (e: EventRow) => {
        if (e.id <= lastSent) return;
        // Relabel with the current aliases (people.json may have been reloaded since filing).
        const labels = labelsFor(ctx.people, ctx.hearings.getCase(k.id)!);
        await stream.writeSSE({ id: String(e.id), event: "court", data: JSON.stringify(publicEvent(e, labels)) });
        lastSent = e.id;
        if ((e.kind === "case.closed" || e.kind === "appeal.closed") && isFinal()) done = true;
      };

      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ number: k.number }), retry: 3000 });
        const backlog = ctx.db.prepare("SELECT * FROM events WHERE case_id = ? AND id > ? ORDER BY id").all(k.id, after) as EventRow[];
        for (const e of backlog) await send(e);

        const now = ctx.hearings.getCase(k.id)!;
        if (FINAL_STATUSES.has(now.status)) done = true;
        else if (OPEN_STATUSES.has(now.status) && !ctx.hearings.isRunning(k.id)) void ctx.hearings.start(k.id);

        const deadline = Date.now() + streamMaxMs;
        while (!closed && !done) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
              wake = () => {
                clearTimeout(t);
                resolve();
              };
            });
            wake = null;
          }
          while (queue.length && !closed) await send(queue.shift()!);
          if (!done && Date.now() >= deadline) {
            await stream.writeSSE({ event: "timeout", data: "{}" });
            break;
          }
        }
        if (done && !closed) await stream.writeSSE({ event: "end", data: "{}" });
      } finally {
        clearInterval(heartbeat);
        ctx.bus.off("event", onEvent);
      }
    });
    res.headers.set("Cache-Control", "no-cache, no-transform"); // streamSSE sets plain no-cache
    return res;
  });

  // ---------- parent passcode ----------

  /** Re-read people.json without restarting. A bad file is rejected and the old list kept. */
  app.post("/admin/reload-people", parent, (c) => {
    try {
      const people = loadPeople(cfg.PEOPLE_FILE);
      ctx.people = people;
      linkParties(ctx.db, people);
      ctx.log(`[court] reloaded people.json: ${people.length} people`);
      return c.json({ ok: true, count: people.length, aliases: people.map((p) => p.alias) });
    } catch (err) {
      if (err instanceof PeopleError) return c.json({ error: `${err.message}\nThe court kept the old list.` }, 400);
      throw err;
    }
  });

  /** Re-read the Family Code from Box now (instead of waiting for the next hearing). */
  app.post("/admin/reload-code", parent, async (c) => {
    const code = await ctx.familyCode.refresh(true);
    return c.json({ ok: true, ...ctx.familyCode.where, articles: code.articles.length, warnings: code.warnings });
  });

  // ---------- lawyer → court (COURT_TOKEN) ----------

  app.get("/law-library", requireTokenOrRole(cfg, "court"), (c) => {
    const code = ctx.familyCode.load();
    return c.json({ text: code.text, articles: code.articles, sentencing: code.sentencing, warnings: code.warnings, origin: ctx.familyCode.where });
  });

  /** Keyword matches plus every landmark: the caller runs the relevance check, like a hearing does. */
  app.get("/api/precedent", requireCourtToken(cfg), (c) =>
    c.json({
      precedent: [
        ...ctx.landmarks.load().landmarks.map(landmarkAsPrecedent),
        ...findPrecedent(ctx.db, c.req.query("q") ?? "", { ignore: ctx.people.map((p) => p.alias) }),
      ],
    }),
  );

  /** Counsel's one-line interjection in the transcript (never seen by the judge's model). */
  app.post("/api/cases/:n{[0-9]+}/remarks", requireCourtToken(cfg), async (c) => {
    const k = ctx.hearings.getCaseByNumber(Number(c.req.param("n")));
    if (!k) return c.json({ error: "The court can't find that case." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    try {
      ctx.hearings.addRemark(k.id, String(body.text ?? ""));
    } catch (err) {
      if (err instanceof RemarkError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json({ ok: true }, 201);
  });

  /** Who can be a party: aliases and roles only. */
  app.get("/api/parties", requireCourtToken(cfg), (c) => c.json({ parties: ctx.people.map(publicParty) }));

  app.post("/api/cases", requireCourtToken(cfg), async (c) => {
    if (!ctx.budget.inSession()) return c.json({ error: RECESS_MESSAGE }, 503);
    const parsed = LawyerFiling.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const f = parsed.data;
    const p = findParty(f.plaintiff);
    const d = findParty(f.defendant);
    if (!p || !d || p.id === d.id) return c.json({ error: "Both parties must be different people on the court's list." }, 400);
    const { id, number } = ctx.hearings.file({
      plaintiff: p.alias,
      defendant: d.alias,
      title: f.title,
      claim: f.claim,
      relief: f.relief,
      filedBy: "lawyer",
      filings: f.argument ? [{ author: p.alias, kind: "argument", body: f.argument }] : [],
    });
    void ctx.hearings.start(id);
    return c.json({ number, url: `${cfg.PUBLIC_BASE_URL || ""}/cases/${number}` }, 201);
  });

  return app;
}
