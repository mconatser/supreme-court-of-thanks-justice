import { describe, expect, it } from "vitest";
import { login, makeApp, readSSE, sseEvents, TEST_ENV } from "./helpers.ts";

const json = (cookie: string, body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", cookie, ...extra },
  body: JSON.stringify(body),
});

const FILING = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  response: "I was in the car first, so I got the front seat.",
};
/** The same case, filed straight into the hearing pipeline with both sides heard. */
const BOTH_SIDES = {
  plaintiff: FILING.plaintiff,
  defendant: FILING.defendant,
  claim: FILING.claim,
  relief: FILING.relief,
  filedBy: "pro_se" as const,
  filings: [{ author: FILING.defendant, kind: "response", body: FILING.response }],
};

describe("auth and pages", () => {
  it("/healthz is public; pages redirect to /login; APIs say 401", async () => {
    const { app } = makeApp();
    const h = await app.request("/healthz");
    expect(await h.json()).toMatchObject({ ok: true });
    const page = await app.request("/", { headers: { accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toMatch(/^\/login/);
    expect((await app.request("/api/docket")).status).toBe(401);
  });

  it("logs in with the court passcode and rejects a wrong one", async () => {
    const { app } = makeApp();
    const bad = await app.request("/login", json("", { passcode: "nope" }));
    expect(bad.status).toBe(401);
    const cookie = await login(app);
    const docket = await app.request("/api/docket", { headers: { cookie } });
    expect(docket.status).toBe(200);
    const d = await docket.json();
    expect(d.inSession).toBe(true);
    expect(d.parties.map((p: any) => p.alias)).toContain("Pip");
    expect(JSON.stringify(d)).not.toContain('"name"'); // real names never leave the server
  });

  it("rejects a tampered session cookie", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const res = await app.request("/api/docket", { headers: { cookie: cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } });
    expect(res.status).toBe(401);
  });

  it("the lawyer passcode can't open the court", async () => {
    const { app } = makeApp();
    const cookie = await login(app, TEST_ENV.LAWYER_PASSCODE);
    expect((await app.request("/api/docket", { headers: { cookie } })).status).toBe(401);
  });
});

describe("pro se filing", () => {
  it("files a case and runs the hearing", async () => {
    const { app, ctx } = makeApp();
    const cookie = await login(app);
    const res = await app.request("/file", json(cookie, FILING));
    expect(res.status).toBe(201);
    const { number, url } = await res.json();
    expect(url).toBe(`/cases/${number}`);
    const k = ctx.hearings.getCaseByNumber(number)!;
    await ctx.hearings.start(k.id);
    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.final).toBe(true);
    expect(view.ruling.seats).toHaveLength(3);
    expect(view.ruling.seats[2]).toMatchObject({ status: "recused", reason: "recused: no precedent yet" });
  });

  it("enforces limits and party rules with friendly errors", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const tooLong = await app.request("/file", json(cookie, { ...FILING, claim: "x".repeat(1501) }));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/1500/);
    const self = await app.request("/file", json(cookie, { ...FILING, defendant: "Pip" }));
    expect((await self.json()).error).toMatch(/yourself/);
    const stranger = await app.request("/file", json(cookie, { ...FILING, defendant: "Darth Vader" }));
    expect(stranger.status).toBe(400);
  });

  it("allows 10 filings per hour per IP", async () => {
    const { app } = makeApp({ JEV_DAILY: "1000" });
    const cookie = await login(app);
    const ip = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 10; i++) expect((await app.request("/file", json(cookie, FILING, ip))).status).toBe(201);
    expect((await app.request("/file", json(cookie, FILING, ip))).status).toBe(429);
    expect((await app.request("/file", json(cookie, FILING, { "x-forwarded-for": "203.0.113.10" }))).status).toBe(201);
  });

  it("JEV_DAILY=1 puts the court in recess (503)", async () => {
    const { app } = makeApp({ JEV_DAILY: "1" });
    const cookie = await login(app);
    const res = await app.request("/file", json(cookie, FILING));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Court is in recess until tomorrow.");
    const d = await (await app.request("/api/docket", { headers: { cookie } })).json();
    expect(d.inSession).toBe(false);
  });
});

describe("SSE stream", () => {
  it("replays from Last-Event-ID, sets no-buffering headers, and closes on a final status", async () => {
    const { app, ctx } = makeApp();
    const cookie = await login(app);
    const { id, number } = ctx.hearings.file(BOTH_SIDES);
    await ctx.hearings.start(id);
    const ids = (ctx.db.prepare("SELECT id FROM events WHERE case_id = ? ORDER BY id").all(id) as { id: number }[]).map((r) => r.id);

    const res = await app.request(`/cases/${number}/stream`, { headers: { cookie, "last-event-id": String(ids[2]) } });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    const events = sseEvents(await readSSE(res));
    const court = events.filter((e) => e.event === "court");
    expect(court.map((e) => Number(e.id))).toEqual(ids.slice(3));
    expect(JSON.parse(court.at(-1)!.data!).kind).toBe("case.closed");
    expect(events.at(-1)!.event).toBe("end");
  });

  it("streams a live hearing to the end", async () => {
    const { app, ctx } = makeApp();
    const cookie = await login(app);
    const { number } = ctx.hearings.file(BOTH_SIDES);
    // Opening the stream starts the hearing (it isn't running yet).
    const res = await app.request(`/cases/${number}/stream`, { headers: { cookie } });
    const events = sseEvents(await readSSE(res));
    const kinds = events.filter((e) => e.event === "court").map((e) => JSON.parse(e.data!).kind);
    expect(kinds[0]).toBe("case.filed");
    expect(kinds.at(-1)).toBe("case.closed");
    expect(events.at(-1)!.event).toBe("end");
  });

  it("sends heartbeat comments and closes after the max duration", async () => {
    const { app, ctx } = makeApp({}, { heartbeatMs: 20, streamMaxMs: 150 });
    const cookie = await login(app);
    const { id, number } = ctx.hearings.file({ ...BOTH_SIDES, filings: [] }); // one-sided: the court summons the defendant
    await ctx.hearings.start(id);
    expect(ctx.hearings.getCase(id)!.status).toBe("awaiting_testimony"); // a paused hearing
    const text = await readSSE(await app.request(`/cases/${number}/stream`, { headers: { cookie } }));
    expect(text).toContain(": heartbeat");
    expect(sseEvents(text).at(-1)!.event).toBe("timeout");
  });
});

describe("lawyer → court (COURT_TOKEN)", () => {
  const token = { "x-court-token": TEST_ENV.COURT_TOKEN };

  it("requires the token for precedent and filing; the law library takes token or passcode", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/precedent?q=front seat")).status).toBe(401);
    expect((await app.request("/api/precedent?q=front seat", { headers: token })).status).toBe(200);
    expect((await app.request("/law-library")).status).toBe(401);
    const lib = await (await app.request("/law-library", { headers: token })).json();
    expect(lib.sentencing).toHaveLength(5);
    const cookie = await login(app);
    expect((await app.request("/law-library", { headers: { cookie } })).status).toBe(200);
  });

  it("files a lawyer case", async () => {
    const { app, ctx } = makeApp();
    const res = await app.request("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json", ...token },
      body: JSON.stringify({ ...FILING, argument: "Article 1 says dibs counts in the same room. We were in the same room." }),
    });
    expect(res.status).toBe(201);
    const { number } = await res.json();
    const k = ctx.hearings.getCaseByNumber(number)!;
    expect(k.filed_by).toBe("lawyer");
    await ctx.hearings.start(k.id);
  });
});
