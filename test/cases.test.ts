/**
 * Max's fixture cases (test/cases/*.json), run through the full hearing in stub mode.
 * Assertions are on outcomes and bands only, never exact probabilities.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeCtx } from "./helpers.ts";

const CaseFile = z.object({
  title: z.string(),
  plaintiff: z.string(),
  defendant: z.string(),
  type_hint: z.enum(["complaint", "petition", "declaration"]).optional(),
  claim: z.string().max(1500),
  relief: z.string(),
  filings: z.array(z.object({ author: z.string(), kind: z.string(), body: z.string().max(1500) })).default([]),
  expect: z.object({
    contempt: z.boolean(),
    status: z.enum(["ruled", "too_close", "contempt"]).optional(),
    outcome: z.enum(["plaintiff", "defendant"]).optional(),
  }),
});

const files = readdirSync("test/cases").filter((f) => f.endsWith(".json")).sort();

describe("fixture cases", () => {
  it("includes at least 3 contempt attempts and a close case", () => {
    const all = files.map((f) => CaseFile.parse(JSON.parse(readFileSync(`test/cases/${f}`, "utf8"))));
    expect(all.filter((c) => c.expect.contempt).length).toBeGreaterThanOrEqual(3);
    expect(all.some((c) => c.expect.status === "too_close")).toBe(true);
  });

  for (const file of files) {
    it(file, async () => {
      const tc = CaseFile.parse(JSON.parse(readFileSync(`test/cases/${file}`, "utf8")));
      const ctx = makeCtx();
      const { id } = ctx.hearings.file({
        plaintiff: tc.plaintiff,
        defendant: tc.defendant,
        title: tc.title,
        claim: tc.claim,
        relief: tc.relief,
        filedBy: "pro_se",
        filings: tc.filings,
      });
      await ctx.hearings.start(id);

      const c = ctx.hearings.getCase(id)!;
      const kinds = (ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);
      expect(kinds[0]).toBe("case.filed");
      expect(kinds.at(-1)).toBe("case.closed");

      if (tc.expect.contempt) {
        expect(c.status).toBe("contempt");
        expect(kinds).toContain("contempt.found");
        const struck = ctx.db.prepare("SELECT COUNT(*) AS n FROM filings WHERE case_id = ? AND struck = 1").get(id) as { n: number };
        expect(struck.n).toBeGreaterThan(0);
      } else {
        expect(c.status).not.toBe("contempt");
        expect(kinds).not.toContain("contempt.found");
      }
      if (tc.expect.status) expect(c.status).toBe(tc.expect.status);
      if (tc.expect.outcome) {
        const r = ctx.db.prepare("SELECT outcome FROM rulings WHERE case_id = ?").get(id) as { outcome: string };
        expect(r.outcome).toBe(tc.expect.outcome);
      }
      if (c.status === "too_close") {
        const r = ctx.db.prepare("SELECT sentence_level, outcome FROM rulings WHERE case_id = ?").get(id) as { sentence_level: number | null; outcome: string };
        expect(r.outcome).toBe("compromise");
        expect(r.sentence_level).toBeNull();
      }
      ctx.db.close();
    });
  }
});
