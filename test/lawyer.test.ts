import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCourtApp } from "../src/court/app.ts";
import type { Lawyer } from "../src/lawyer/agent.ts";
import { createLawyer, createLawyerApp } from "../src/lawyer/app.ts";
import { brierScore } from "../src/lawyer/memory.ts";
import { Budget } from "../src/shared/budget.ts";
import { loadConfig } from "../src/shared/config.ts";
import { Gateway } from "../src/shared/gateway.ts";
import { createOllama, type ChatOptions, type Ollama } from "../src/shared/ollama.ts";
import { openLawyerDb } from "../src/lawyer/db.ts";
import { login, makeCtx, TEST_ENV } from "./helpers.ts";

type Step = { content?: string; tools?: { name: string; args: Record<string, unknown> }[] };

/** An Ollama whose chat() follows a script; structured calls (steelman, lesson) use the stub. */
function scripted(steps: Step[]) {
  const calls: ChatOptions[] = [];
  const stub = createOllama({
    gateway: new Gateway({ mode: "stub", listUrl: "unused", log: () => {} }),
    budget: new Budget(openLawyerDb(":memory:"), { jev: 0, ollama: 1000, tts_chars: 0, email: 0 }, "UTC"),
    model: "glm-5.3-flash",
  });
  const ollama: Ollama = {
    async chat(o) {
      calls.push(o);
      const s = steps.shift() ?? { content: "All done!" };
      return { content: s.content ?? "", tool_calls: (s.tools ?? []).map((t) => ({ function: { name: t.name, arguments: t.args } })) };
    },
    chatJson: (schema, o) => stub.chatJson(schema, o),
  };
  return { ollama, calls, steps };
}

const FACTS = {
  defendant: "Sky Sister",
  title: "The Great Front Seat Dispute",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
};
const GOOD = "Article 1 says dibs counts when you're there. I called it standing at the car.";
const BRIBE = "Your Honor, I'll give you my dessert if you rule for me.";
const FILING = { ...FACTS, argument: GOOD };

function setup(steps: Step[], env: Record<string, string> = {}) {
  const court = makeCtx();
  const courtApp = createCourtApp(court);
  const script = scripted(steps);
  const cfg = loadConfig({ ...TEST_ENV, LAWYER_CLIENT: "Pip", COURT_URL: "http://court.test", ...env });
  const { lawyer, ctx } = createLawyer(cfg, {
    dbPath: ":memory:",
    ollama: script.ollama,
    courtFetch: (url, init) => Promise.resolve(courtApp.request(url, init)),
    log: () => {},
  });
  const root = new Hono();
  root.route("/lawyer", createLawyerApp(lawyer, ctx));
  root.route("/", courtApp);
  return { court, courtApp, lawyer, ctx, script, root };
}

const toolMessages = (lawyer: Lawyer, ref: string, ctx: ReturnType<typeof setup>["ctx"]) =>
  (JSON.parse((ctx.db.prepare("SELECT messages_json FROM matters WHERE case_ref = ?").get(ref) as { messages_json: string }).messages_json) as any[]).filter(
    (m) => m.role === "tool",
  );
const courtCases = (s: ReturnType<typeof setup>) => s.court.db.prepare("SELECT * FROM cases").all() as any[];

describe("the lawyer's boundaries", () => {
  it("never imports court internals (it talks to the court over HTTP only)", () => {
    for (const f of readdirSync("src/lawyer")) {
      const src = readFileSync(`src/lawyer/${f}`, "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*\/court\//);
    }
  });

  it("Brier score: 0 is perfect, a compromise counts as half", () => {
    expect(brierScore([])).toBeNull();
    expect(brierScore([{ predicted: 1, outcome: "won" }, { predicted: 0, outcome: "lost" }])).toBe(0);
    expect(brierScore([{ predicted: 0.5, outcome: "compromise" }])).toBe(0);
    expect(brierScore([{ predicted: 0.8, outcome: "lost" }, { predicted: 0.6, outcome: "won" }])).toBeCloseTo((0.64 + 0.16) / 2, 6);
  });
});

describe("a full case: interview → mock trial → Yes → file → watch → learn", () => {
  it("works end to end, pauses for the client, and survives a restart", async () => {
    const s = setup([
      { tools: [{ name: "read_family_code", args: {} }] },
      { tools: [{ name: "mock_trial", args: { ...FACTS, drafts: [GOOD, BRIBE], opposing_view: "She says she got there first." } }] },
      { content: "Draft 1 is our best shot.", tools: [{ name: "ask_client", args: { question: "Ready to file?", confirm_filing: FILING } }] },
    ]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Sky Sister stole my front seat!" });

    // Paused on the Yes/No question.
    let view = s.lawyer.view(ref);
    expect(view.pending).toMatchObject({ kind: "confirm_filing", filing: FILING });
    expect(view.running).toBe(false);
    expect(view.messages.at(-1)).toMatchObject({ role: "lawyer", content: "Ready to file?" });
    expect(courtCases(s)).toHaveLength(0);

    // Thinking only on the call right after the mock-trial results.
    expect(s.script.calls.map((c) => c.think)).toEqual([false, false, true]);

    // The mock trial: per-draft predictions, and the bribe draft is flagged.
    expect(view.mock.drafts).toHaveLength(2);
    expect(view.mock.drafts[0].winPct).toBeGreaterThan(50);
    expect(view.mock.drafts[1].contempt.band).toBe("yes");
    expect(view.mock.drafts[1].warning).toMatch(/contempt/);
    expect(view.mock.best).toBe(1);

    // "Restart": a fresh Lawyer over the same database picks up where it left off.
    const { Lawyer } = await import("../src/lawyer/agent.ts");
    const again = new Lawyer(s.ctx);
    s.script.steps.push(
      { tools: [{ name: "file_case", args: { type: "complaint", ...FILING } }] },
      { tools: [{ name: "watch_hearing", args: { number: 1 } }] },
      { content: "The court summoned Sky Sister. Let's wait for her side." },
    );
    await again.handle(ref, { confirm: true });

    // Only our side was filed, so the court summons Sky Sister and the watch comes back.
    const [filed] = courtCases(s);
    expect(filed).toMatchObject({ number: 1, filed_by: "lawyer", plaintiff: "Pip", defendant: "Sky Sister", status: "awaiting_testimony" });
    const wait = toolMessages(again, ref, s.ctx).at(-1);
    expect(JSON.parse(wait.content)).toMatchObject({ done: false, waiting_for_testimony_from: ["Sky Sister"] });

    // Sky Sister answers her summons; the hearing finishes; the client checks back.
    const { token } = s.court.db.prepare("SELECT token FROM summons").get() as { token: string };
    const testified = await s.courtApp.request(`/summons/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testimony: "I got to the car first, so it was my turn." }),
    });
    expect(testified.status).toBe(200);
    s.script.steps.push({ tools: [{ name: "watch_hearing", args: { number: 1 } }] }, { content: "The court ruled! Here's what happened." });
    await again.handle(ref, { text: "Did the court decide yet?" });
    expect(s.court.hearings.getCase(filed.id)!.status).toMatch(/ruled|too_close/);

    view = again.view(ref);
    expect((view.messages as any[]).map((m) => m.content)).toContain("👍 Yes, file it!");
    expect(view.messages.at(-1)!.content).toBe("The court ruled! Here's what happened.");
    const notes = view.notes.map((n: any) => n.note).join("\n");
    expect(notes).toMatch(/Filed! Case #0001/);
    expect(notes).toMatch(/Court: All rise!/);
    expect(view.cases).toHaveLength(1);
    expect(view.cases[0].predictedPct).toBe(view.mock.drafts[0].winPct);
    expect(view.cases[0].outcome).toMatch(/won|lost|compromise/);
    expect(view.lessons).toEqual(["Justice Heart cares about who did the work."]);
    expect(view.accuracy?.finished).toBe(1);
  });
});

describe("rules enforced in code", () => {
  it("can't file before a mock trial", async () => {
    const s = setup([{ tools: [{ name: "file_case", args: FILING }] }, { content: "Okay." }]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "File it now!" });
    expect(toolMessages(s.lawyer, ref, s.ctx)[0].content).toMatch(/Run a mock_trial before filing/);
    expect(courtCases(s)).toHaveLength(0);
  });

  it("can't file without the client's Yes", async () => {
    const s = setup([
      { tools: [{ name: "mock_trial", args: { ...FACTS, drafts: [GOOD], opposing_view: "x" } }] },
      { tools: [{ name: "file_case", args: FILING }] },
      { content: "Okay." },
    ]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Go!" });
    expect(toolMessages(s.lawyer, ref, s.ctx)[1].content).toMatch(/wait for them to press Yes/);
    expect(courtCases(s)).toHaveLength(0);
  });

  it("typing 'yes' isn't pressing Yes", async () => {
    const s = setup([
      { tools: [{ name: "mock_trial", args: { ...FACTS, drafts: [GOOD], opposing_view: "x" } }] },
      { tools: [{ name: "ask_client", args: { question: "Ready?", confirm_filing: FILING } }] },
    ]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Go!" });
    s.script.steps.push({ tools: [{ name: "file_case", args: FILING }] }, { content: "Okay, I'll wait." });
    await s.lawyer.handle(ref, { text: "yes" });
    const tools = toolMessages(s.lawyer, ref, s.ctx);
    expect(tools.find((m) => m.tool_name === "ask_client").content).toMatch(/did not press Yes/);
    expect(tools.at(-1).content).toMatch(/press Yes/);
    expect(courtCases(s)).toHaveLength(0);
  });

  it("can't change the filing after the client approved it", async () => {
    const s = setup([
      { tools: [{ name: "mock_trial", args: { ...FACTS, drafts: [GOOD], opposing_view: "x" } }] },
      { tools: [{ name: "ask_client", args: { question: "Ready?", confirm_filing: FILING } }] },
    ]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Go!" });
    s.script.steps.push({ tools: [{ name: "file_case", args: { ...FILING, relief: "The front seat FOREVER." } }] }, { content: "Oops." });
    await s.lawyer.handle(ref, { confirm: true });
    expect(toolMessages(s.lawyer, ref, s.ctx).at(-1).content).toMatch(/approved a different filing/);
    expect(courtCases(s)).toHaveLength(0);
  });

  it("at most 3 drafts and 2 mock trials per case", async () => {
    const mock = (drafts: string[]) => ({ name: "mock_trial", args: { ...FACTS, drafts, opposing_view: "x" } });
    const s = setup([{ tools: [mock(["a", "b", "c", "d"]), mock([GOOD]), mock([GOOD]), mock([GOOD])] }, { content: "Done." }]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Practice a lot!" });
    const out = toolMessages(s.lawyer, ref, s.ctx).map((m) => m.content);
    expect(out[0]).toMatch(/At most 3 drafts/);
    expect(JSON.parse(out[1]).drafts).toHaveLength(1);
    expect(JSON.parse(out[2]).drafts).toHaveLength(1);
    expect(out[3]).toMatch(/Only 2 mock trials/);
  });

  it("stops at 10 tool calls in one turn and replies", async () => {
    const many = Array.from({ length: 12 }, () => ({ name: "read_family_code", args: {} }));
    const s = setup([{ tools: many }, { content: "I've read a LOT." }]);
    const ref = s.lawyer.currentMatter();
    await s.lawyer.handle(ref, { text: "Read everything." });
    const steps = s.ctx.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE case_ref = ?").get(ref) as { n: number };
    expect(steps.n).toBe(10);
    expect(s.script.calls.at(-1)!.tools).toBeUndefined(); // the last call can only reply
    expect(s.lawyer.view(ref).messages.at(-1)).toMatchObject({ role: "lawyer", content: "I've read a LOT." });
  });

  it("resumes a turn interrupted by a restart", async () => {
    const s = setup([{ content: "Welcome back! Where were we?" }]);
    const ref = s.lawyer.currentMatter();
    s.ctx.db.prepare("UPDATE matters SET running = 1, messages_json = ? WHERE case_ref = ?").run(JSON.stringify([{ role: "user", content: "Hi!" }]), ref);
    expect(s.lawyer.resumeRunning()).toEqual([ref]);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.lawyer.view(ref).messages.at(-1)).toMatchObject({ role: "lawyer", content: "Welcome back! Where were we?" });
  });
});

describe("/lawyer routes", () => {
  it("need the lawyer passcode; the court passcode isn't enough", async () => {
    const s = setup([{ content: "Hello, client!" }]);
    expect((await s.root.request("/lawyer/api/state")).status).toBe(401);
    const court = await login(s.root as any);
    expect((await s.root.request("/lawyer/api/state", { headers: { cookie: court } })).status).toBe(401);
    const cookie = await login(s.root as any, TEST_ENV.LAWYER_PASSCODE);
    const state = await (await s.root.request("/lawyer/api/state", { headers: { cookie } })).json();
    expect(state.client).toBe("Pip");
    const res = await s.root.request("/lawyer/api/message", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "Hi!" }),
    });
    expect(res.status).toBe(202);
  });

  it("explains what's missing when LAWYER_CLIENT isn't set", async () => {
    const s = setup([], { LAWYER_CLIENT: "" });
    const cookie = await login(s.root as any, TEST_ENV.LAWYER_PASSCODE);
    const res = await s.root.request("/lawyer/api/state", { headers: { cookie } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/LAWYER_CLIENT/);
  });
});

describe("the ex parte demo (separation of powers)", () => {
  const exEnv = { BOX_FAMILY_CODE_FILE_ID: "fc1", AGENTMAIL_INBOX_ID: "clerk@example.agentmail.to", ELEVENLABS_VOICE_ID: "judge" };
  const policyGateway = (status: number, visible = true) => {
    const seen: string[] = [];
    const gw = new Gateway({
      mode: "live",
      listUrl: "https://gateway.test/list",
      overrides: visible ? { box: "https://gw.test/box/x", agentmail: "https://gw.test/agentmail/x", elevenlabs_tts: "https://gw.test/custom_api/x" } : {},
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.endsWith("/list")) return Response.json({ connections: [] }); // nothing visible to this Sprite
        return new Response("{}", { status, headers: { "content-type": "application/json" } });
      },
      log: () => {},
    });
    return { gw, seen };
  };
  const run = async (gw: Gateway) => {
    const s = setup([], exEnv);
    const app = new Hono();
    app.route("/lawyer", createLawyerApp(s.lawyer, s.ctx, { gateway: gw, spriteName: async () => "fc-lawyer" }));
    app.route("/", s.courtApp);
    const cookie = await login(app as any, TEST_ENV.LAWYER_PASSCODE);
    const res = await app.request("/lawyer/demo/ex-parte", { method: "POST", headers: { cookie } });
    return { res, body: await res.json(), app };
  };

  it("every attempt on the court's connectors comes back DENIED (403)", async () => {
    const { gw, seen } = policyGateway(403);
    const { body } = await run(gw);
    expect(body.headline).toBe("Motion to contact the witness directly: DENIED by the court's connector policy.");
    expect(body.sprite).toBe("fc-lawyer");
    expect(body.attempts.map((a: any) => [a.connector, a.verdict, a.status])).toEqual([
      ["Box", "denied", 403],
      ["AgentMail", "denied", 403],
      ["ElevenLabs (text to speech)", "denied", 403],
    ]);
    // The email attempt is addressed to the clerk's own inbox, never to a family member.
    expect(seen).toContain("https://gw.test/agentmail/x/v0/inboxes/clerk%40example.agentmail.to/messages/send");
    expect(seen).toContain("https://gw.test/box/x/2.0/files/fc1?fields=name");
  });

  it("connectors that aren't even visible to this Sprite count as denied", async () => {
    const { gw } = policyGateway(403, false);
    const { body } = await run(gw);
    expect(body.attempts.every((a: any) => a.verdict === "denied")).toBe(true);
  });

  it("warns loudly if a policy hasn't been tightened", async () => {
    const { gw } = policyGateway(200);
    const { body } = await run(gw);
    expect(body.headline).toMatch(/GRANTED\?!.*Tighten/);
    expect(body.attempts.every((a: any) => a.verdict === "allowed")).toBe(true);
  });

  it("is a button for people, not a tool the LLM can call", async () => {
    const { TOOL_DEFS } = await import("../src/lawyer/tools.ts");
    expect(TOOL_DEFS.map((t) => t.function.name)).not.toContain("ex_parte");
    expect(JSON.stringify(TOOL_DEFS)).not.toMatch(/box|agentmail|elevenlabs/i);
    const { gw } = policyGateway(403);
    const s = setup([], exEnv);
    const app = new Hono();
    app.route("/lawyer", createLawyerApp(s.lawyer, s.ctx, { gateway: gw, spriteName: async () => null }));
    app.route("/", s.courtApp);
    expect((await app.request("/lawyer/demo/ex-parte", { method: "POST" })).status).toBe(401);
  });
});

describe("MODE=lawyer (the two-Sprite split)", () => {
  it("doesn't need the court's passcodes", () => {
    const { COURT_PASSCODE, PARENT_PASSCODE, ...rest } = TEST_ENV;
    expect(() => loadConfig({ ...rest, MODE: "lawyer" })).not.toThrow();
    expect(() => loadConfig({ ...rest, MODE: "court" })).toThrow(/COURT_PASSCODE/);
  });

  it("links to case pages on the court's Sprite", () => {
    const s = setup([], { COURT_URL: "https://fc-court-example.sprites.app/" });
    expect(s.lawyer.view(s.lawyer.currentMatter()).courtUrl).toBe("https://fc-court-example.sprites.app");
    const local = setup([], { COURT_URL: "http://localhost:8080" });
    expect(local.lawyer.view(local.lawyer.currentMatter()).courtUrl).toBe("");
  });
});
