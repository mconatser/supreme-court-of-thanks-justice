/** What the lawyer remembers between cases: predictions vs outcomes, and one-line lessons. */
import type { LawyerDB } from "./db.ts";

export type Outcome = "won" | "lost" | "compromise" | "contempt";

/** How a result scores for accuracy: a compromise counts as half a win. */
export const OUTCOME_SCORE: Record<Outcome, number> = { won: 1, compromise: 0.5, lost: 0, contempt: 0 };

export function recentLessons(db: LawyerDB, n = 10): string[] {
  return (db.prepare("SELECT text FROM lessons ORDER BY id DESC LIMIT ?").all(n) as { text: string }[]).map((r) => r.text).reverse();
}

export function addLesson(db: LawyerDB, text: string) {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (line) db.prepare("INSERT INTO lessons(text, created_at) VALUES (?, ?)").run(line, Date.now());
}

export interface CaseRecord {
  case_ref: string;
  title: string | null;
  court_case_number: number | null;
  predicted: number | null;
  outcome: Outcome | null;
  vote: string | null;
  created_at: number;
}

export function caseList(db: LawyerDB): CaseRecord[] {
  return db.prepare("SELECT * FROM cases WHERE court_case_number IS NOT NULL ORDER BY created_at DESC LIMIT 50").all() as CaseRecord[];
}

/** Brier score over finished cases (0 is perfect, 0.25 is a coin flip). Null until a case finishes. */
export function brierScore(cases: Pick<CaseRecord, "predicted" | "outcome">[]): number | null {
  const done = cases.filter((c) => c.predicted != null && c.outcome != null);
  if (!done.length) return null;
  return done.reduce((s, c) => s + (c.predicted! - OUTCOME_SCORE[c.outcome!]) ** 2, 0) / done.length;
}
