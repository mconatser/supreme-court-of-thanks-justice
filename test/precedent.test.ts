import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { labelsFor } from "../src/court/labels.ts";
import { findPrecedent } from "../src/court/precedent.ts";
import type { FileInput, PrecedentCheck } from "../src/court/hearing.ts";
import { stubCalls } from "../src/shared/stub.ts";
import { login, makeApp, makeCtx, readSSE, sseEvents, TEST_ENV } from "./helpers.ts";

const HOT_DOG = {
  plaintiff: "Pip",
  defendant: "The Big Cheese",
  claim: "A hot dog is a sandwich. It is meat inside bread.",
  relief: "The court declares that a hot dog is a sandwich.",
  filedBy: "pro_se" as const,
  filings: [{ author: "The Big Cheese", kind: "response", body: "A hot dog is its own thing." }],
};
// Shares the word "declares" with the hot-dog case, and nothing else that matters.
const COOKIE = {
  plaintiff: "Pip",
  defendant: "The Big Cheese",
  claim: "I offered the last cookie to everyone and nobody answered, so I ate it.",
  relief: "The court declares I shared fairly.",
  filedBy: "pro_se" as const,
  filings: [{ author: "The Big Cheese", kind: "response", body: "Nobody heard the offer." }],
};

type Ctx = ReturnType<typeof makeCtx>;
const rule = async (ctx: Ctx, input: FileInput) => {
  const { id, number } = ctx.hearings.file(input);
  await ctx.hearings.start(id);
  return { id, number };
};
const checkOf = (ctx: Ctx, id: number) => {
  const row = ctx.db.prepare("SELECT data_json FROM events WHERE case_id = ? AND kind = 'precedent.checked'").get(id) as { data_json: string };
  return JSON.parse(row.data_json) as PrecedentCheck;
};
const memorySeat = (ctx: Ctx, id: number) => {
  const r = ctx.db.prepare("SELECT panel_json FROM rulings WHERE case_id = ?").get(id) as { panel_json: string };
  return JSON.parse(r.panel_json)[2];
};
const relevanceCalls = (since: number) =>
  stubCalls.slice(since).filter((c) => c.provider === "typesafe" && Object.keys(c.body.questions).some((k) => k.startsWith("relevant_")));

describe("precedent relevance (Justice Memory)", () => {
  it("party aliases never count as keywords", () => {
    const ctx = makeCtx();
    return rule(ctx, COOKIE).then(() => {
      const q = "Pip v. The Big Cheese: whose turn is it on the swing?";
      expect(findPrecedent(ctx.db, q, { ignore: ["Pip", "The Big Cheese"] })).toEqual([]);
    });
  });

  it("no keyword candidates: no relevance call, and Memory recuses with 'no precedent yet'", async () => {
    const ctx = makeCtx();
    const before = stubCalls.length;
    const { id } = await rule(ctx, HOT_DOG);
    expect(relevanceCalls(before)).toHaveLength(0);
    expect(checkOf(ctx, id)).toEqual({ candidates: [], kept: [] });
    expect(memorySeat(ctx, id)).toMatchObject({ status: "recused", reason: "recused: no precedent yet" });
  });

  it("(a) a keyword match that Jev finds irrelevant is dropped, and Memory recuses", async () => {
    const ctx = makeCtx();
    await rule(ctx, COOKIE);
    const before = stubCalls.length;
    const { id } = await rule(ctx, HOT_DOG);

    const check = checkOf(ctx, id);
    expect(check.candidates.map((c) => c.number)).toEqual([1]); // keyword search found the cookie case…
    expect(check.candidates[0].p).toBeLessThan(0.7); // …Jev said it isn't relevant…
    expect(check.kept).toEqual([]); // …so it never reaches the panel
    expect(memorySeat(ctx, id)).toMatchObject({ status: "recused", reason: "recused: no relevant precedent" });

    const deliberation = stubCalls.slice(before).find((c) => c.provider === "typesafe" && c.body.questions.justice_letter)!;
    expect(deliberation.body.questions.justice_memory).toBeUndefined();
    expect(deliberation.body.state.precedent).toEqual([]);
  });

  it("(a) batches every candidate into one Jev request and keeps only P >= 0.7", async () => {
    const ctx = makeCtx();
    await rule(ctx, COOKIE); // #1: keyword match, irrelevant
    await rule(ctx, { ...HOT_DOG, claim: "Hot dogs are sandwiches: meat in bread." }); // #2: relevant
    const before = stubCalls.length;
    const { id } = await rule(ctx, HOT_DOG);

    const calls = relevanceCalls(before);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body.questions).sort()).toEqual(["relevant_P1", "relevant_P2"]);
    const check = checkOf(ctx, id);
    expect(check.kept.map((p) => p.number)).toEqual([2]);
    for (const c of check.candidates) expect(c.p >= 0.7).toBe(c.number === 2);

    const seat = memorySeat(ctx, id);
    expect(seat.status).toBe("voted");
    expect(seat.cites).toEqual(["P2"]);
  });

  it("a resumed hearing reuses the stored relevance answers", async () => {
    const ctx = makeCtx();
    await rule(ctx, HOT_DOG);
    const { id } = await rule(ctx, HOT_DOG);
    const before = stubCalls.length;
    ctx.db.prepare("DELETE FROM events WHERE case_id = ? AND kind IN ('deliberation.started','deliberation.done','ruling.decided','opinion.written','case.closed')").run(id);
    ctx.db.prepare("DELETE FROM rulings WHERE case_id = ?").run(id);
    ctx.db.prepare("UPDATE cases SET status = 'deliberating' WHERE id = ?").run(id);
    await ctx.hearings.start(id);
    expect(relevanceCalls(before)).toHaveLength(0);
    expect(memorySeat(ctx, id).cites).toEqual(["P1"]);
  });

  it("(b) Justice Memory's card shows the cited case number and title", async () => {
    const { app, ctx } = makeApp();
    const cookie = await login(app);
    await rule(ctx, { ...HOT_DOG, title: "The Great Hot Dog Debate" });
    const { number } = await rule(ctx, HOT_DOG);
    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    const memory = view.ruling.seats.find((s: any) => s.key === "justice_memory");
    expect(memory.status).toBe("voted");
    expect(memory.cites).toEqual([{ ref: "P1", number: 1, label: "Case #0001", title: "The Great Hot Dog Debate", landmark: false }]);
  });
});

describe("too close: which way the panel leaned", () => {
  const CLOSE = {
    plaintiff: "Pip",
    defendant: "Sky Sister",
    claim: "We both called the front seat at exactly the same time.",
    relief: "I get the front seat today.",
    filedBy: "pro_se" as const,
    filings: [{ author: "Sky Sister", kind: "response", body: "We called it at the same time, but I touched the door first." }],
  };

  it("shows the lean and vote on the card, docket and transcript", async () => {
    const { app, ctx } = makeApp();
    const cookie = await login(app);
    const { number } = await rule(ctx, CLOSE);
    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.status).toBe("too_close");
    expect(view.ruling.outcome).toBe("compromise");
    expect(view.ruling.lean).toMatchObject({ party: expect.stringMatching(/^(Pip|Sky Sister)$/), vote: expect.stringMatching(/^\d–\d$/) });

    const docket = await (await app.request("/api/docket", { headers: { cookie } })).json();
    expect(docket.cases[0].lean).toEqual(view.ruling.lean);

    const msg = ctx.db.prepare("SELECT message FROM events WHERE kind = 'ruling.decided'").get() as { message: string };
    expect(msg.message).toContain(`leaning ${view.ruling.lean.party} ${view.ruling.lean.vote}`);
  });

  it("a tie has no lean", async () => {
    const { leanOf } = await import("../src/court/views.ts");
    const seat = (choice: "plaintiff" | "defendant") => ({ key: "justice_letter", status: "voted", choice, probabilities: { plaintiff: 0.5, defendant: 0.5 }, confidence: 0.5, name: "x" }) as any;
    expect(leanOf([seat("plaintiff"), seat("defendant")])).toBeNull();
    expect(leanOf([seat("defendant"), seat("defendant"), seat("plaintiff")])).toEqual({ side: "defendant", vote: "2–1" });
  });
});

describe("aliases everywhere, and reloading people.json", () => {
  const peopleFile = (people: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "fc-people-"));
    const path = join(dir, "people.json");
    writeFileSync(path, JSON.stringify(people));
    return path;
  };
  const PEOPLE = [
    { id: "p1", name: "Real Name One", alias: "The Big Cheese", role: "parent" },
    { id: "p2", name: "Real Name Two", alias: "Pip", role: "kid" },
    { id: "p3", name: "Real Name Three", alias: "Sky Sister", role: "kid" },
  ];

  it("relabels generated text in one pass, even when aliases swap", () => {
    const people = [
      { id: "a", alias: "Sky Sister", name: "", email: "", role: "kid" as const },
      { id: "b", alias: "Pip", name: "", email: "", role: "kid" as const },
    ];
    const L = labelsFor(people, { plaintiff: "Pip", defendant: "Sky Sister", plaintiff_id: "a", defendant_id: "b" });
    expect(L.plaintiff).toBe("Sky Sister");
    expect(L.relabel("Pip v. Sky Sister: the court rules for Pip.")).toBe("Sky Sister v. Pip: the court rules for Sky Sister.");
    expect(L.relabel("Pipsqueak stays")).toBe("Pipsqueak stays"); // whole words only
  });

  it("the browser never sees ids or real names", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    const d = await (await app.request("/api/docket", { headers: { cookie } })).json();
    for (const p of d.parties) expect(Object.keys(p).sort()).toEqual(["alias", "role"]);
  });

  it("only a parent can reload; a bad file is rejected and the old list kept", async () => {
    const path = peopleFile([{ id: "p1", alias: "", role: "parent" }]);
    const { app, ctx } = makeApp({ PEOPLE_FILE: path });
    const courtCookie = await login(app);
    expect((await app.request("/admin/reload-people", { method: "POST", headers: { cookie: courtCookie } })).status).toBe(403);
    expect((await app.request("/admin/reload-people", { method: "POST" })).status).toBe(401);

    const parentCookie = await login(app, TEST_ENV.PARENT_PASSCODE);
    const res = await app.request("/admin/reload-people", { method: "POST", headers: { cookie: parentCookie } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs a court alias[\s\S]*kept the old list/);
    expect(ctx.people.map((p) => p.alias)).toContain("Pip");
  });

  it("after a reload, old cases show the new aliases everywhere; filing bodies stay as written", async () => {
    const path = peopleFile(PEOPLE);
    const { app, ctx } = makeApp({ PEOPLE_FILE: path });
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const { id, number } = await rule(ctx, { ...HOT_DOG, claim: "Pip says a hot dog is a sandwich. It is meat inside bread." });

    writeFileSync(path, JSON.stringify(PEOPLE.map((p) => (p.id === "p2" ? { ...p, alias: "Captain Mustard" } : p))));
    const reload = await app.request("/admin/reload-people", { method: "POST", headers: { cookie: parent } });
    expect(reload.status).toBe(200);

    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie: parent } })).json();
    expect(view.plaintiff).toBe("Captain Mustard");
    expect(view.title).toBe("Captain Mustard v. The Big Cheese");
    expect(view.filings[0].author).toBe("Captain Mustard");
    expect(view.filings[0].body).toContain("Pip says"); // the party's own words aren't rewritten
    expect(view.ruling.winner).toBe("Captain Mustard");
    expect(view.ruling.benchVerdict).toContain("Captain Mustard");
    expect(view.ruling.benchVerdict).not.toMatch(/\bPip\b/);
    expect(view.ruling.seats.filter((s: any) => s.status === "voted").every((s: any) => s.party === "Captain Mustard")).toBe(true);

    const docket = await (await app.request("/api/docket", { headers: { cookie: parent } })).json();
    expect(docket.cases[0]).toMatchObject({ plaintiff: "Captain Mustard", title: "Captain Mustard v. The Big Cheese" });

    const sse = sseEvents(await readSSE(await app.request(`/cases/${number}/stream`, { headers: { cookie: parent } })));
    const messages = sse.filter((e) => e.event === "court").map((e) => JSON.parse(e.data!).message).join("\n");
    expect(messages).toContain("Captain Mustard");
    expect(messages).not.toMatch(/\bPip\b/);

    // New filings use the new alias.
    const filed = await app.request("/file", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: parent },
      body: JSON.stringify({ plaintiff: "Captain Mustard", defendant: "Sky Sister", claim: "She took my spot on the couch.", relief: "My spot back." }),
    });
    expect(filed.status).toBe(201);
    expect(ctx.hearings.getCase(id)!.plaintiff_id).toBe("p2");
  });
});

describe("a 1–1 split: no “% sure”, the justices strongly disagree (fc-court showed 87%)", () => {
  it("decide() gives a split even odds, and the card/record/opinion say the justices disagree", async () => {
    const { decide } = await import("../src/shared/panel.ts");
    const j = (p: number) => ({ choice: p >= 0.5 ? "plaintiff" : "defendant", confidence: Math.max(p, 1 - p), probabilities: { plaintiff: p, defendant: 1 - p } });
    const d = decide({ caseType: "petition", justices: { justice_letter: j(0.9), justice_heart: j(0.15) } });
    expect(d).toMatchObject({ status: "too_close", reason: "tie", lean: null, vote: "1–1", caseConfidence: 0.5 });
  });

  it("a stored split (old rulings kept the justices' own certainty) still hides the meter", async () => {
    const { app, ctx } = makeApp({ BOX_RECORDS_FOLDER_ID: "rec" });
    const cookie = await login(app);
    const { id, number } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "Sky Sister",
      claim: "We both called the front seat at exactly the same time.",
      relief: "Front seat today.",
      filedBy: "pro_se",
      filings: [{ author: "Sky Sister", kind: "response", body: "We called it at the same time." }],
    });
    await ctx.hearings.start(id);
    // Rewrite the panel as a confident 1–1 split, as on fc-court (case_confidence 0.87).
    const seat = (key: string, choice: string, p: number) => ({ key, status: "voted", choice, probabilities: { plaintiff: choice === "plaintiff" ? p : 1 - p, defendant: choice === "defendant" ? p : 1 - p }, confidence: p, name: key });
    ctx.db
      .prepare("UPDATE rulings SET outcome = 'compromise', vote = '1–1', case_confidence = 0.87, panel_json = ? WHERE case_id = ?")
      .run(JSON.stringify([seat("justice_letter", "plaintiff", 0.9), seat("justice_heart", "defendant", 0.84), { key: "justice_memory", status: "recused", reason: "recused: no precedent yet", name: "justice_memory" }]), id);
    const v = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(v.ruling.split).toBe(true);
    expect(v.ruling.confidencePct).toBeNull();
    const { renderRecord } = await import("../src/court/record.ts");
    const { caseView } = await import("../src/court/views.ts");
    const md = renderRecord(caseView(ctx.hearings.getCase(id)!, ctx), "Court");
    expect(md).toContain("**Split 1–1:** the justices strongly disagree");
    expect(md).not.toContain("**Confidence:**");
  });
});

describe("a compromise on a petition needs a parent's OK too", () => {
  it("too close on a petition → awaiting approval, approvable like a granted one", async () => {
    const { app, ctx } = makeApp();
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const { id, number } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "The Big Cheese",
      claim: "My bedtime should be later because we both called it at exactly the same time that we'd talk about it.",
      relief: "Bedtime is 9pm on Fridays.",
      filedBy: "pro_se",
      filings: [{ author: "The Big Cheese", kind: "response", body: "We both called it at the same time, so let's discuss." }],
    });
    await ctx.hearings.start(id);
    const c = ctx.hearings.getCase(id)!;
    expect(c.type).toBe("petition");
    expect(c.status).toBe("too_close");
    expect(c.approval).toBe("pending");
    const v = await (await app.request(`/api/cases/${number}`, { headers: { cookie: parent } })).json();
    expect(v.ruling.petitionRecommended).toBe(true);
    const ok = await app.request(`/cases/${number}/approval`, { method: "POST", headers: { "content-type": "application/json", cookie: parent }, body: JSON.stringify({ decision: "approve" }) });
    expect(ok.status).toBe(200);
  });

  it("a petition the defendant wins needs nothing", async () => {
    const { needsParentOk } = await import("../src/court/hearing.ts");
    expect(needsParentOk({ kind: "ruled", decision: { outcome: "defendant" } as any }, "petition")).toBe(false);
    expect(needsParentOk({ kind: "too_close", decision: null }, "petition")).toBe(true);
    expect(needsParentOk({ kind: "too_close", decision: null }, "complaint")).toBe(false);
  });
});
