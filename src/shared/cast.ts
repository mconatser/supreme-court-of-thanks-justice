/**
 * Display names. Placeholders until Max names everyone (MISSIONS.md, Mission 1).
 * He can override them by creating content/cast.json with any of these keys.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Cast {
  court: string;
  judge: string;
  lawyer: string;
  justices: { letter: string; heart: string; memory: string };
}

export const DEFAULT_CAST: Cast = {
  court: "Family Court",
  judge: "The Judge",
  lawyer: "Counsel",
  justices: { letter: "Justice Letter", heart: "Justice Heart", memory: "Justice Memory" },
};

export function loadCast(contentDir: string): Cast {
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "cast.json"), "utf8"));
    return {
      ...DEFAULT_CAST,
      ...raw,
      justices: { ...DEFAULT_CAST.justices, ...(raw?.justices ?? {}) },
    };
  } catch {
    return DEFAULT_CAST;
  }
}
