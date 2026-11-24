/**
 * Max's test cases (test/cases/*.json) and how to check them. Shared by the stub-mode tests
 * (test/cases.test.ts) and the real-Jev run (npm run eval:live), so both judge the same way.
 */
import { z } from "zod";
import type { CourtContext } from "../src/court/context.ts";

export const CaseFile = z.object({
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
    /** Who wins: the plaintiff or the defendant. */
    outcome: z.enum(["plaintiff", "defendant"]).optional(),
    type: z.enum(["complaint", "petition", "declaration"]).optional(),
    /** A sentence from the guidelines comes with the ruling. */
    sentence: z.boolean().optional(),
    /** If the petition is granted or compromised, it waits for a parent. */
    parent_ok_if_decided: z.boolean().optional(),
  }),
});
export type CaseFile = z.infer<typeof CaseFile>;

export interface Check {
  name: string;
  want: string;
  got: string;
  ok: boolean;
}

/** Every expectation in the case file, against what the court actually did. */
export function checkExpectations(ctx: CourtContext, caseId: number, exp: CaseFile["expect"]): Check[] {
  const c = ctx.hearings.getCase(caseId)!;
  const r = ctx.db.prepare("SELECT outcome, sentence_level FROM rulings WHERE case_id = ? ORDER BY round DESC LIMIT 1").get(caseId) as
    | { outcome: string; sentence_level: number | null }
    | undefined;
  const checks: Check[] = [];
  const add = (name: string, want: unknown, got: unknown) => checks.push({ name, want: String(want), got: String(got), ok: String(want) === String(got) });

  add("contempt", exp.contempt, c.status === "contempt");
  if (exp.status) add("status", exp.status, c.status);
  if (exp.outcome) add("winner", exp.outcome, r?.outcome ?? "none");
  if (exp.type) add("type", exp.type, c.type);
  if (exp.sentence !== undefined) add("sentence", exp.sentence, r?.sentence_level != null);
  if (exp.parent_ok_if_decided) {
    const decided = (c.status === "ruled" && r?.outcome === "plaintiff") || c.status === "too_close";
    add("waits for a parent", decided ? "pending" : "(not needed)", decided ? c.approval : "(not needed)");
  }
  return checks;
}
