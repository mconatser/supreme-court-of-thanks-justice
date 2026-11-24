import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * people.json (gitignored) lists the family. Only `alias` ever leaves this machine:
 * aliases are what the court shows, files and sends to Jev and Ollama.
 */
const PersonSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().default(""),
  alias: z.string().default(""),
  email: z.string().default(""),
  /** guests can file and be parties; only parents approve petitions. */
  role: z.enum(["parent", "kid", "guest"]),
});

export type Person = z.infer<typeof PersonSchema>;

export class PeopleError extends Error {}

export function parsePeople(raw: unknown, source = "people.json"): Person[] {
  const parsed = z.array(PersonSchema).min(1).safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - entry ${i.path.join(".")}: ${i.message}`);
    throw new PeopleError(
      `${source} doesn't look right yet. Each person needs an id, an alias and a role (parent, kid or guest):\n${lines.join("\n")}`,
    );
  }
  const people = parsed.data.map((p) => ({ ...p, alias: p.alias.trim(), email: p.email.trim() }));

  // Entries are named by position and alias, never by id: ids can be real first names, and these
  // messages reach the logs and a parent's browser ("Reload the family list").
  const which = (i: number) => `entry ${i + 1}${people[i].alias ? ` (${people[i].alias})` : ""}`;
  const missing = people.map((p, i) => (p.alias === "" ? which(i) : null)).filter(Boolean);
  if (missing.length) {
    throw new PeopleError(
      `Everyone in ${source} needs a court alias (a code name) before court can open.\n` +
        `  Add an "alias" for: ${missing.join(", ")}`,
    );
  }
  const seenIds = new Map<string, number>();
  const seenAliases = new Map<string, number>();
  people.forEach((p, i) => {
    if (seenIds.has(p.id)) throw new PeopleError(`${source}: ${which(seenIds.get(p.id)!)} and ${which(i)} have the same id. Each person needs their own id.`);
    seenIds.set(p.id, i);
    const key = p.alias.toLowerCase();
    if (seenAliases.has(key)) {
      throw new PeopleError(`${source}: ${which(seenAliases.get(key)!)} and ${which(i)} have the same alias. Each court alias must be different.`);
    }
    seenAliases.set(key, i);
  });
  return people;
}

export function loadPeople(path: string): Person[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new PeopleError(`Couldn't find ${path}. Create it from the example in SPEC.md section 5.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PeopleError(`${path} isn't valid JSON. Check for a missing comma or quote.`);
  }
  return parsePeople(raw, path);
}

/** What the browser may see about a person: alias and role only (ids can be real names). */
export function publicParty(p: Person) {
  return { alias: p.alias, role: p.role };
}
