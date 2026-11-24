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
  role: z.enum(["parent", "kid"]),
});

export type Person = z.infer<typeof PersonSchema>;

export class PeopleError extends Error {}

export function parsePeople(raw: unknown, source = "people.json"): Person[] {
  const parsed = z.array(PersonSchema).min(1).safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - entry ${i.path.join(".")}: ${i.message}`);
    throw new PeopleError(
      `${source} doesn't look right yet. Each person needs an id, an alias and a role (parent or kid):\n${lines.join("\n")}`,
    );
  }
  const people = parsed.data.map((p) => ({ ...p, alias: p.alias.trim(), email: p.email.trim() }));

  const missing = people.filter((p) => p.alias === "").map((p) => p.id);
  if (missing.length) {
    throw new PeopleError(
      `Everyone in ${source} needs a court alias (a code name) before court can open.\n` +
        `  Add an "alias" for: ${missing.join(", ")}`,
    );
  }
  const seenIds = new Set<string>();
  const seenAliases = new Map<string, string>();
  for (const p of people) {
    if (seenIds.has(p.id)) throw new PeopleError(`${source}: the id "${p.id}" is used twice. Each person needs their own id.`);
    seenIds.add(p.id);
    const key = p.alias.toLowerCase();
    const other = seenAliases.get(key);
    if (other) {
      throw new PeopleError(`${source}: "${other}" and "${p.id}" have the same alias. Each court alias must be different.`);
    }
    seenAliases.set(key, p.id);
  }
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
