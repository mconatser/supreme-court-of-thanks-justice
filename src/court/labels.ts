/**
 * Display labels: always the party's *current* alias from people.json.
 *
 * Cases store an alias snapshot (what Jev and Ollama saw at the time) plus the person id. When
 * people.json is reloaded with new aliases, generated text (titles, transcript lines, opinions,
 * verdicts) is relabeled from the snapshot to the current alias. Filing bodies stay as written.
 */
import type { Person } from "../shared/people.ts";
import type { CaseRow } from "./db.ts";

export interface Labels {
  plaintiff: string;
  defendant: string;
  /** Alias for a stored (snapshot, id) pair. */
  party(snapshot: string, id: string | null): string;
  /** Replace any outdated alias snapshots in generated text. */
  relabel(text: string): string;
  relabel(text: string | null): string | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function currentAlias(people: Person[], snapshot: string, id: string | null): string {
  return (id && people.find((p) => p.id === id)?.alias) || snapshot;
}

export function labelsFor(people: Person[], c: Pick<CaseRow, "plaintiff" | "defendant" | "plaintiff_id" | "defendant_id">): Labels {
  const plaintiff = currentAlias(people, c.plaintiff, c.plaintiff_id);
  const defendant = currentAlias(people, c.defendant, c.defendant_id);
  const map = new Map<string, string>();
  if (plaintiff !== c.plaintiff) map.set(c.plaintiff.toLowerCase(), plaintiff);
  if (defendant !== c.defendant) map.set(c.defendant.toLowerCase(), defendant);
  // One pass with an alternation (longest first), so swapped aliases don't clobber each other.
  const re = map.size
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(${[...map.keys()].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\p{L}\\p{N}_])`, "giu")
    : null;
  const relabel = ((text: string | null) => (text == null || !re ? text : text.replace(re, (m) => map.get(m.toLowerCase()) ?? m))) as Labels["relabel"];
  return {
    plaintiff,
    defendant,
    party: (snapshot, id) => (id ? currentAlias(people, snapshot, id) : relabel(snapshot)),
    relabel,
  };
}
