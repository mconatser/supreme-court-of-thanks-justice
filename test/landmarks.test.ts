import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { landmarkAsPrecedent, parseLandmarks } from "../src/court/landmarks.ts";
import { parsePeople } from "../src/shared/people.ts";
import { stubCalls } from "../src/shared/stub.ts";
import { login, makeApp, makeCtx, TEST_ENV } from "./helpers.ts";

const TEMPLATE = "test/fixtures/landmarks-sample.md";

describe("landmark cases", () => {
  it("loads Max's landmarks from content/landmark-cases.md", () => {
    const { landmarks, warnings } = parseLandmarks(readFileSync("content/landmark-cases.md", "utf8"));
    expect(warnings).toEqual([]);
    expect(landmarks.map((l) => [l.ref, l.articles])).toEqual([
      ["L1", [1]],
      ["L2", [2]],
      ["L3", [4]],
      ["L4", [3]],
      ["L5", [5]],
    ]);
    // The optional "Case:" line travels with the question into precedent.
    const l4 = landmarks.find((l) => l.ref === "L4")!;
    expect(l4.caption).toBe("Dad v. Hailey (2024)");
    expect(landmarkAsPrecedent(l4).question).toContain("(Dad v. Hailey (2024))");
  });

  it("ignores a landmark still marked as a placeholder", () => {
    const { landmarks, warnings } = parseLandmarks("## Landmark L1. (Placeholder: old example) Dibs\nQuestion: q\nOutcome: o\n\n## Landmark L2. Real one\nQuestion: q\nOutcome: o\n");
    expect(landmarks.map((l) => l.ref)).toEqual(["L2"]);
    expect(warnings.join(" ")).toMatch(/L1 is still a placeholder/);
  });

  it("parses landmarks: refs, questions, outcomes and articles", () => {
    const { landmarks, warnings } = parseLandmarks(readFileSync(TEMPLATE, "utf8"));
    expect(warnings).toEqual([]);
    expect(landmarks.map((l) => l.ref)).toEqual(["L1", "L2"]);
    expect(landmarks[0]).toMatchObject({ vote: "3–0", articles: [1] });
    expect(landmarks[0].question).toContain("dibs");
    expect(landmarks[1].outcome).toContain("cookie");
  });

  it("skips landmarks missing a Question or Outcome, and duplicate numbers, with polite warnings", () => {
    const { landmarks, warnings } = parseLandmarks(
      "## Landmark L1. Good\nQuestion: q\nOutcome: o\nVote: 3–0\nArticles: 1, 4\n\n## Landmark L2. Half done\nQuestion: q\n\n## Landmark L1. Again\nQuestion: q\nOutcome: o\n",
    );
    expect(landmarks.map((l) => l.ref)).toEqual(["L1"]);
    expect(landmarks[0].articles).toEqual([1, 4]);
    expect(warnings).toHaveLength(2);
  });

  it("a fresh court seats all three justices on case #1 when a landmark is relevant", async () => {
    const { app, ctx } = makeApp({}, {}, { landmarksPath: TEMPLATE });
    const cookie = await login(app);
    const before = stubCalls.length;
    const { id, number } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "Sky Sister",
      claim: "Sky Sister called dibs on the TV remote from the kitchen while it was in the living room.",
      relief: "The remote is mine tonight.",
      filedBy: "pro_se",
      filings: [{ author: "Sky Sister", kind: "response", body: "I called dibs first, so it counts." }],
    });
    await ctx.hearings.start(id);
    expect(number).toBe(1);

    const relevance = stubCalls.slice(before).find((c) => c.provider === "typesafe" && c.body.questions.relevant_L1)!;
    expect(Object.keys(relevance.body.questions).sort()).toEqual(["relevant_L1", "relevant_L2"]);

    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.ruling.seats.map((s: any) => s.status)).toEqual(["voted", "voted", "voted"]);
    const memory = view.ruling.seats[2];
    expect(memory.cites).toEqual([{ ref: "L1", label: "Landmark L1", title: "The Great Dibs Ruling", landmark: true }]);
  });

  it("an off-topic case #1 gets no landmark: Justice Memory recuses", async () => {
    const ctx = makeCtx({}, { landmarksPath: TEMPLATE });
    const { id } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "The Big Cheese",
      claim: "A hot dog is a sandwich. It is meat inside bread.",
      relief: "The court declares a hot dog is a sandwich.",
      filedBy: "pro_se",
      filings: [{ author: "The Big Cheese", kind: "response", body: "A hot dog is its own thing." }],
    });
    await ctx.hearings.start(id);
    const r = ctx.db.prepare("SELECT panel_json FROM rulings WHERE case_id = ?").get(id) as { panel_json: string };
    expect(JSON.parse(r.panel_json)[2]).toMatchObject({ status: "recused", reason: "recused: no relevant precedent" });
  });
});

describe("guests and petition approval", () => {
  const PETITION = {
    plaintiff: "Pip",
    defendant: "The Big Cheese",
    claim: "My bedtime should be later on Fridays because there is no school on Saturday.",
    relief: "Bedtime is 9pm on Fridays.",
  };

  it("accepts a guest role", () => {
    const people = parsePeople([{ id: "g1", alias: "Cousin Comet", role: "guest" }]);
    expect(people[0].role).toBe("guest");
  });

  it("guests can file and be parties", async () => {
    const guest = { id: "g1", alias: "Cousin Comet", role: "guest" as const, name: "", email: "" };
    const { app, ctx } = makeApp();
    ctx.people = [...ctx.people, guest];
    const cookie = await login(app);
    const res = await app.request("/file", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ plaintiff: "Cousin Comet", defendant: "Pip", claim: "Pip hid my shoes before dinner.", relief: "My shoes back." }),
    });
    expect(res.status).toBe(201);
    const { number } = await res.json();
    expect(ctx.hearings.getCaseByNumber(number)).toMatchObject({ plaintiff: "Cousin Comet", plaintiff_id: "g1" });
  });

  it("a granted petition waits for a parent; only a parent can approve, once", async () => {
    const { app, ctx } = makeApp();
    const court = await login(app);
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const { id, number } = ctx.hearings.file({
      ...PETITION,
      filedBy: "pro_se",
      filings: [{ author: "The Big Cheese", kind: "response", body: "Sleep matters, even on Fridays." }],
    });
    await ctx.hearings.start(id);
    const c = ctx.hearings.getCase(id)!;
    expect(c.type).toBe("petition");
    expect(c.status).toBe("ruled");
    expect(c.approval).toBe("pending");

    const asCourt = await (await app.request(`/api/cases/${number}`, { headers: { cookie: court } })).json();
    expect(asCourt.viewer.isParent).toBe(false);
    const post = (cookie: string, decision: string) =>
      app.request(`/cases/${number}/approval`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ decision }) });
    expect((await post(court, "approve")).status).toBe(403);
    expect((await post(parent, "maybe")).status).toBe(400);

    const ok = await post(parent, "approve");
    expect(ok.status).toBe(200);
    expect((await ok.json()).approval).toBe("approved");
    expect((await post(parent, "deny")).status).toBe(409);
    const ev = ctx.db.prepare("SELECT actor, message FROM events WHERE case_id = ? AND kind = 'petition.approved'").get(id) as any;
    expect(ev.actor).toBe("executive");
  });

  it("other case types never need approval", async () => {
    const ctx = makeCtx();
    const { id } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "Sky Sister",
      claim: "Sky Sister took the front seat even though I called it first.",
      relief: "Front seat for a week.",
      filedBy: "pro_se",
      filings: [{ author: "Sky Sister", kind: "response", body: "I was there first." }],
    });
    await ctx.hearings.start(id);
    expect(ctx.hearings.getCase(id)!.approval).toBeNull();
  });
});

describe("justice personalities (content/judge-persona.md)", () => {
  it("are read from Max's table and reach the opinion, dissent included", async () => {
    const { loadCast, parsePersonalities } = await import("../src/shared/cast.ts");
    const cast = loadCast("content");
    expect(cast.personalities.letter).toMatch(/strict/i);
    expect(cast.personalities.heart).toMatch(/fair to everyone/i);
    expect(cast.personalities.memory).toMatch(/remembers every case/i);
    expect(parsePersonalities("no table")).toEqual({ letter: "", heart: "", memory: "" });

    const { opinionUserPrompt } = await import("../src/court/opinion.ts");
    const prompt = opinionUserPrompt({
      kind: "ruled", caseNumber: 1, title: "t", caseType: "complaint", plaintiff: "Max", defendant: "Hailey", claim: "c", relief: "r",
      winner: "Max", loser: "Hailey", vote: "2–1", confidencePct: 70, articles: [], filings: [],
      justices: [{ name: "Justice Cody", vote: "Max (80%)", personality: cast.personalities.letter }],
      dissenter: "Justice Grace", dissenterPersonality: cast.personalities.heart,
    });
    expect(prompt).toContain(`When a justice speaks (like a dissent), use their personality: Justice Cody: ${cast.personalities.letter}`);
    expect(prompt).toContain(`Dissent: written by Justice Grace, in their own voice (${cast.personalities.heart})`);
  });
});
