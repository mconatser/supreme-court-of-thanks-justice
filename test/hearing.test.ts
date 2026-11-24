import { describe, expect, it } from "vitest";
import { writeOpinion, type OpinionFacts } from "../src/court/opinion.ts";
import { RecessError } from "../src/shared/budget.ts";
import type { Jev } from "../src/shared/jev.ts";
import type { Ollama } from "../src/shared/ollama.ts";
import { stubCalls } from "../src/shared/stub.ts";
import { makeCtx } from "./helpers.ts";

const HOT_DOG = {
  plaintiff: "Pip",
  defendant: "The Big Cheese",
  claim: "A hot dog is a sandwich. It is meat inside bread.",
  relief: "The court declares that a hot dog is a sandwich.",
  filedBy: "pro_se" as const,
  filings: [{ author: "The Big Cheese", kind: "response", body: "A hot dog is its own thing." }],
};

const kinds = (ctx: ReturnType<typeof makeCtx>, id: number) =>
  (ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);

describe("hearing pipeline", () => {
  it("runs every step in order and records a ruling with three seats", async () => {
    const ctx = makeCtx();
    const { id } = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(id);
    expect(kinds(ctx, id)).toEqual([
      "case.filed",
      "court.opened",
      "screening.done",
      "law.loaded",
      "sufficiency.done",
      "precedent.checked",
      "deliberation.started",
      "deliberation.done",
      "ruling.decided",
      "opinion.written",
      "case.closed",
    ]);
    const c = ctx.hearings.getCase(id)!;
    expect(c.status).toBe("ruled");
    expect(c.type).toBe("declaration");
    const r = ctx.db.prepare("SELECT * FROM rulings WHERE case_id = ?").get(id) as any;
    const seats = JSON.parse(r.panel_json);
    expect(seats).toHaveLength(3);
    expect(seats[2]).toMatchObject({ key: "justice_memory", status: "recused", reason: "recused: no precedent yet" });
    expect(r.bench_verdict).toContain("Pip");
  });

  it("seats Justice Memory once there's matching precedent", async () => {
    const ctx = makeCtx();
    const first = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(first.id);
    const second = ctx.hearings.file({ ...HOT_DOG, claim: "A hot dog is still a sandwich, Your Honor. Bread plus meat." });
    await ctx.hearings.start(second.id);
    const r = ctx.db.prepare("SELECT panel_json FROM rulings WHERE case_id = ?").get(second.id) as any;
    expect(JSON.parse(r.panel_json).map((s: any) => s.status)).toEqual(["voted", "voted", "voted"]);
  });

  it("resuming reuses stored Jev answers instead of asking again", async () => {
    const ctx = makeCtx();
    const { id } = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(id);
    const before = stubCalls.filter((c) => c.provider === "typesafe").length;

    // Pretend the Sprite slept mid-hearing: roll the status back and drop the last steps.
    ctx.db.prepare("DELETE FROM events WHERE case_id = ? AND kind IN ('opinion.written', 'case.closed')").run(id);
    ctx.db.prepare("UPDATE cases SET status = 'deliberating' WHERE id = ?").run(id);
    expect(ctx.hearings.resumeOpen()).toEqual([id]);
    await ctx.hearings.start(id);

    expect(stubCalls.filter((c) => c.provider === "typesafe").length).toBe(before);
    expect(ctx.hearings.getCase(id)!.status).toBe("ruled");
    expect(kinds(ctx, id).filter((k) => k === "ruling.decided")).toHaveLength(1);
  });

  it("goes into recess mid-hearing when the Jev budget runs out, then picks up later", async () => {
    const ctx = makeCtx({ JEV_DAILY: "2" });
    const { id } = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(id);
    expect(kinds(ctx, id).at(-1)).toBe("court.recess");
    expect(ctx.hearings.getCase(id)!.status).toBe("deliberating");

    ctx.db.prepare("DELETE FROM budget").run(); // a new day
    await ctx.hearings.start(id);
    expect(ctx.hearings.getCase(id)!.status).toBe("ruled");
  });

  it("logs a friendly snag (once) when the judge can't be reached", async () => {
    const broken: Jev = { ask: async () => { throw new Error("boom"); } };
    const ctx = makeCtx({}, { jev: broken });
    const { id } = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(id);
    await ctx.hearings.start(id);
    expect(kinds(ctx, id).filter((k) => k === "court.trouble")).toHaveLength(1);
    expect(ctx.hearings.getCase(id)!.status).toBe("screening");
  });
});

describe("opinion", () => {
  const facts: OpinionFacts = {
    kind: "ruled",
    caseNumber: 7,
    title: "Pip v. The Big Cheese",
    caseType: "declaration",
    plaintiff: "Pip",
    defendant: "The Big Cheese",
    claim: "x",
    relief: "y",
    winner: "Pip",
    loser: "The Big Cheese",
    vote: "2–0",
    confidencePct: 81,
    justices: [],
    articles: [{ number: 1, title: "Dibs" }],
    filings: [],
  };

  const fakeOllama = (replies: unknown[]) => {
    const calls: any[] = [];
    const o: Ollama = {
      chat: async () => ({ content: "", tool_calls: [] }),
      chatJson: async (_schema, opts) => {
        calls.push(opts);
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next as any;
      },
    };
    return { o, calls };
  };

  it("writes with thinking off and keeps only real cited articles", async () => {
    const { o, calls } = fakeOllama([{ opinion_md: "Pip wins.", bench_verdict: "Pip wins!", cited_articles: [1, 99] }]);
    const op = await writeOpinion(o, "persona", facts, () => {});
    expect(calls[0].think).toBe(false);
    expect(op).toMatchObject({ source: "llm", cited_articles: [1] });
  });

  it("regenerates once if the bench verdict doesn't name the winner, then uses the template", async () => {
    const bad = { opinion_md: "x", bench_verdict: "Somebody wins!", cited_articles: [] };
    const { o, calls } = fakeOllama([bad, bad, bad]);
    const op = await writeOpinion(o, "persona", facts, () => {});
    expect(calls).toHaveLength(2);
    expect(op.source).toBe("template");
    expect(op.bench_verdict).toContain("Pip");
    expect(op.bench_verdict.length).toBeLessThanOrEqual(300);
  });

  it("a too-close verdict may say 'compromise' or name both parties", async () => {
    const close = { ...facts, kind: "too_close" as const, winner: undefined, loser: undefined };
    const both = { opinion_md: "x", bench_verdict: "Pip and The Big Cheese, take turns!", cited_articles: [] };
    expect((await writeOpinion(fakeOllama([both]).o, "p", close, () => {})).source).toBe("llm");
    const neither = { opinion_md: "x", bench_verdict: "Take turns, everyone!", cited_articles: [] };
    expect((await writeOpinion(fakeOllama([neither, neither]).o, "p", close, () => {})).source).toBe("template");
  });

  it("goes straight to the template when the Ollama budget is used up", async () => {
    const { o, calls } = fakeOllama([new RecessError("ollama")]);
    const op = await writeOpinion(o, "persona", facts, () => {});
    expect(calls).toHaveLength(1);
    expect(op.source).toBe("template");
  });

  it("the real Ollama client sends think: false on the wire", async () => {
    const ctx = makeCtx();
    const { id } = ctx.hearings.file(HOT_DOG);
    await ctx.hearings.start(id);
    const chat = stubCalls.filter((c) => c.provider === "ollama" && c.path === "/api/chat").at(-1)!;
    expect(chat.body.think).toBe(false);
    expect(chat.body.format).toBeTypeOf("object");
    expect(chat.body.model).toBe("glm-5.3-flash");
  });
});
