/**
 * Landmark cases (content/landmark-cases.md): Max's made-up historic rulings. They join the
 * precedent candidates on every hearing, so a fresh court can seat Justice Memory from case #1,
 * but only when the Jev relevance check (P >= 0.7) says a landmark fits the dispute.
 */
import { readFileSync, statSync } from "node:fs";
import type { Precedent } from "../shared/panel.ts";

export interface Landmark {
  ref: string; // "L1"
  title: string;
  question: string;
  outcome: string;
  vote: string;
  articles: number[];
}

export interface LandmarkFile {
  landmarks: Landmark[];
  warnings: string[];
}

export function parseLandmarks(md: string): LandmarkFile {
  const text = md.replace(/<!--[\s\S]*?-->/g, "");
  const landmarks: Landmark[] = [];
  const warnings: string[] = [];
  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [headingLine, ...rest] = section.split("\n");
    const h = headingLine.match(/^Landmark\s+L?(\d+)\.?\s*(.*)$/i);
    if (!h) continue;
    const ref = `L${Number(h[1])}`;
    const field = (name: string) => rest.find((l) => new RegExp(`^\\s*${name}\\s*:`, "i").test(l))?.replace(/^[^:]*:\s*/, "").trim() ?? "";
    const lm: Landmark = {
      ref,
      title: h[2].trim(),
      question: field("Question"),
      outcome: field("Outcome"),
      vote: field("Vote"),
      articles: (field("Articles").match(/\d+/g) ?? []).map(Number),
    };
    if (!lm.question || !lm.outcome) {
      warnings.push(`Landmark ${ref} needs both a Question and an Outcome line, so the court skipped it.`);
      continue;
    }
    if (landmarks.some((x) => x.ref === ref)) {
      warnings.push(`There are two landmarks numbered ${ref}. The court kept the first one.`);
      continue;
    }
    landmarks.push(lm);
  }
  return { landmarks, warnings };
}

export function landmarkAsPrecedent(lm: Landmark): Precedent {
  return {
    ref: lm.ref,
    title: lm.title,
    case: `Landmark ${lm.ref}`,
    question: `${lm.title}: ${lm.question}`,
    outcome: lm.outcome,
    vote: lm.vote,
    articles: lm.articles,
  };
}

/** Reads the landmarks file, re-parsing only when it changes. A missing file means no landmarks. */
export class LandmarkSource {
  private cached?: { mtimeMs: number; file: LandmarkFile };
  constructor(private readonly path: string) {}

  load(): LandmarkFile {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return { landmarks: [], warnings: [] };
    }
    if (this.cached?.mtimeMs !== mtimeMs) this.cached = { mtimeMs, file: parseLandmarks(readFileSync(this.path, "utf8")) };
    return this.cached.file;
  }

  find(ref: string): Landmark | undefined {
    return this.load().landmarks.find((l) => l.ref === ref);
  }
}
