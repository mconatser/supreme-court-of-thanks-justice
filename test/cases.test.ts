/**
 * Max's test cases (test/cases/*.json), run through the full hearing in stub mode, checked by
 * the same rules as npm run eval:live (test/caseExpect.ts). Outcomes and bands only, never exact
 * probabilities. The stub's keywords stand in for Jev here; eval:live is the real check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseFile, checkExpectations } from "./caseExpect.ts";
import { makeCtx } from "./helpers.ts";

const files = readdirSync("test/cases").filter((f) => f.endsWith(".json")).sort();
const load = (f: string) => CaseFile.parse(JSON.parse(readFileSync(`test/cases/${f}`, "utf8")));

describe("fixture cases", () => {
  it("includes at least 3 contempt attempts and a close case", () => {
    const all = files.map(load);
    expect(all.filter((c) => c.expect.contempt).length).toBeGreaterThanOrEqual(3);
    expect(all.some((c) => c.expect.status === "too_close")).toBe(true);
  });

  for (const file of files) {
    it(file, async () => {
      const tc = load(file);
      const ctx = makeCtx({}, { landmarksPath: "content/landmark-cases.md" });
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

      for (const check of checkExpectations(ctx, id, tc.expect)) {
        expect(check.got, `${file}: ${check.name}`).toBe(check.want);
      }
      if (tc.expect.contempt) {
        const struck = ctx.db.prepare("SELECT COUNT(*) AS n FROM filings WHERE case_id = ? AND struck = 1").get(id) as { n: number };
        expect(struck.n).toBeGreaterThan(0);
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
