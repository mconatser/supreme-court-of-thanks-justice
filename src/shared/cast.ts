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
  /** From the justices table in content/judge-persona.md (Max's words); "" until written. */
  personalities: { letter: string; heart: string; memory: string };
  /** The judge's gavel catchphrase (content/judge-persona.md): the spoken verdict ends with it. */
  catchphrase: string;
}

/** The first quoted line under "**Gavel catchphrase:**". */
export function parseCatchphrase(personaMd: string): string | null {
  const m = personaMd.match(/\*\*Gavel catchphrase:\*\*\s*\n\s*-\s*"([^"\n]+)"/i);
  return m?.[1]?.trim() || null;
}

const SEAT_ROWS: Record<keyof Cast["personalities"], RegExp> = {
  letter: /^rules as written$/i,
  heart: /^what'?s fair$/i,
  memory: /^what the court decided before$/i,
};

/** Read each seat's personality from the "| Seat | Name | Personality |" table. */
export function parsePersonalities(personaMd: string): Cast["personalities"] {
  const out = { letter: "", heart: "", memory: "" };
  for (const line of personaMd.split("\n")) {
    const cells = line.split("|").map((x) => x.trim());
    if (cells.length < 5) continue;
    for (const [seat, re] of Object.entries(SEAT_ROWS) as [keyof typeof out, RegExp][]) {
      if (re.test(cells[1])) out[seat] = cells[3];
    }
  }
  return out;
}

export const DEFAULT_CAST: Cast = {
  court: "Family Court",
  judge: "The Judge",
  lawyer: "Counsel",
  justices: { letter: "Justice Letter", heart: "Justice Heart", memory: "Justice Memory" },
  personalities: { letter: "", heart: "", memory: "" },
  catchphrase: "The end!",
};

export function loadCast(contentDir: string): Cast {
  let cast: Cast = DEFAULT_CAST;
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "cast.json"), "utf8"));
    cast = { ...DEFAULT_CAST, ...raw, justices: { ...DEFAULT_CAST.justices, ...(raw?.justices ?? {}) } };
  } catch {}
  try {
    const persona = readFileSync(join(contentDir, "judge-persona.md"), "utf8");
    cast = { ...cast, personalities: parsePersonalities(persona), catchphrase: parseCatchphrase(persona) ?? cast.catchphrase };
  } catch {}
  return cast;
}
