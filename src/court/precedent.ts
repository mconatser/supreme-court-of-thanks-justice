/** Past rulings as precedent: a simple keyword match (SPEC §8.1 /api/precedent, §8.3 state). */
import type { DB } from "./db.ts";
import type { Precedent } from "../shared/panel.ts";

const STOP = new Set(
  "the and for that this with you your are was were has have had but not his her its our they them their what when who why how from into onto about because said says say she him all any can could would should will just like than then there here also very really honor court case judge please".split(
    " ",
  ),
);

export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? [])].filter((w) => !STOP.has(w));
}

export const caseLabel = (n: number) => `Case #${String(n).padStart(4, "0")}`;

/**
 * Keyword candidates only; the hearing then asks Jev which are actually relevant. Party aliases
 * never count as keywords: "dad v. max" shouldn't match every other case dad was in.
 */
export function findPrecedent(
  db: DB,
  query: string,
  opts: { excludeCaseId?: number; limit?: number; ignore?: string[] } = {},
): Precedent[] {
  const ignored = new Set(keywords((opts.ignore ?? []).join(" ")));
  const words = keywords(query).filter((w) => !ignored.has(w));
  if (!words.length) return [];
  const rows = db
    .prepare(
      `SELECT c.id, c.number, c.title, c.claim, c.relief, c.plaintiff, c.defendant, r.outcome, r.vote, r.cited_articles_json
         FROM cases c JOIN rulings r ON r.case_id = c.id AND r.round = (SELECT MAX(round) FROM rulings WHERE case_id = c.id)
        WHERE c.status IN ('ruled', 'too_close') AND c.id != ?
        ORDER BY c.number DESC LIMIT 500`,
    )
    .all(opts.excludeCaseId ?? -1) as {
    id: number;
    number: number;
    title: string;
    claim: string;
    relief: string;
    plaintiff: string;
    defendant: string;
    outcome: string;
    vote: string;
    cited_articles_json: string | null;
  }[];

  return rows
    .map((r) => {
      const own = new Set(keywords(`${r.plaintiff} ${r.defendant}`));
      const hay = new Set(keywords(`${r.title} ${r.claim} ${r.relief}`).filter((w) => !own.has(w)));
      return { r, score: words.filter((w) => hay.has(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.number - a.r.number)
    .slice(0, opts.limit ?? 8)
    .map(({ r }) => ({
      ref: `P${r.number}`,
      number: r.number,
      title: r.title,
      case: caseLabel(r.number),
      question: `${r.title}: ${r.claim}`.slice(0, 240),
      outcome:
        r.outcome === "plaintiff"
          ? `${r.plaintiff} prevailed`
          : r.outcome === "defendant"
            ? `${r.defendant} prevailed`
            : "too close; compromise ordered",
      vote: r.vote ?? "",
      articles: r.cited_articles_json ? (JSON.parse(r.cited_articles_json) as number[]) : [],
    }));
}
