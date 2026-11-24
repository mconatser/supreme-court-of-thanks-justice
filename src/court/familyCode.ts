/**
 * The Family Code: Max's laws. Phase 1 reads content/family-code.md; Phase 2 moves the
 * source of truth to Box (cached by file version).
 *
 * Articles are `## Article N. Title` headings. Sentencing guidelines are a numbered list (0–4)
 * under `## Sentencing Guidelines`. If parsing fails, fall back to default tiers with a warning.
 */
import { readFileSync, statSync } from "node:fs";

export interface Article {
  number: number;
  title: string;
  body: string;
}

export interface FamilyCode {
  /** Text sent to Jev and shown in the law library (HTML comments stripped). */
  text: string;
  articles: Article[];
  sentencing: string[];
  usingDefaultSentencing: boolean;
  /** Polite notes for the docket. */
  warnings: string[];
}

export const DEFAULT_SENTENCING = [
  "Case closed with a friendly warning",
  "A sincere apology to the other party",
  "One extra chore for the other party",
  "Lose first pick (front seat, dessert choice or the remote) for a day",
  "Lose a privilege for a weekend, as approved by a parent",
];

const isPlaceholder = (s: string) => /^\s*\(.*\)\s*$/.test(s) || s.trim() === "" || s.includes("(…)") || s.includes("(...)");

export function parseFamilyCode(md: string): FamilyCode {
  const text = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const warnings: string[] = [];

  // Split into level-2 sections.
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
      current = { heading: m[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });

  const articles: Article[] = [];
  const templateArticles: number[] = [];
  for (const s of sections) {
    const m = s.heading.match(/^Article\s+(\d+)\.?\s*(.*)$/i);
    if (!m) continue;
    const number = Number(m[1]);
    const title = m[2].trim();
    if (isPlaceholder(title) || isPlaceholder(s.body) || /delete me/i.test(title)) templateArticles.push(number);
    articles.push({ number, title, body: s.body });
  }
  if (!articles.length) warnings.push("The court couldn't find any articles in the Family Code yet.");
  if (templateArticles.length) {
    warnings.push(`Some articles are still examples or blanks (Article ${templateArticles.join(", ")}). The lawmaker has homework!`);
  }

  let sentencing: string[] = [];
  const sg = sections.find((s) => /^sentencing guidelines/i.test(s.heading));
  if (sg) {
    for (const line of sg.body.split("\n")) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (m) sentencing[Number(m[1])] = m[2].trim();
    }
  }
  sentencing = Array.from({ length: 5 }, (_, i) => sentencing[i] ?? "");
  const usingDefaultSentencing = sentencing.some(isPlaceholder);
  if (usingDefaultSentencing) {
    sentencing = [...DEFAULT_SENTENCING];
    warnings.push("The Sentencing Guidelines aren't finished, so the court is using its built-in punishments for now.");
  }

  return { text, articles, sentencing, usingDefaultSentencing, warnings };
}

/** Reads the Family Code from a file, re-parsing only when the file changes. */
export class FamilyCodeSource {
  private cached?: { mtimeMs: number; code: FamilyCode };

  constructor(private readonly path: string) {}

  load(): FamilyCode {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return { ...parseFamilyCode(""), warnings: ["The court couldn't find the Family Code file."] };
    }
    if (this.cached?.mtimeMs !== mtimeMs) {
      this.cached = { mtimeMs, code: parseFamilyCode(readFileSync(this.path, "utf8")) };
    }
    return this.cached.code;
  }
}
