import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SENTENCING, parseFamilyCode } from "../src/court/familyCode.ts";

const SAMPLE = `# The Family Code

## Article 1. Dibs
Calling "dibs" only counts if you are in the same room as the thing.

## Article 2. The Last Cookie
The last cookie must be offered to everyone at the table before anyone eats it.

## Article 7. Front Seat
Whoever is oldest gets the front seat, unless it's someone's birthday.

## Sentencing Guidelines
0. Case closed with a warning
1. Say sorry and mean it
2. Do the other person's chore once
3. No dessert tonight
4. No screens for a day
`;

describe("parseFamilyCode", () => {
  it("parses articles by number and the five sentencing levels", () => {
    const code = parseFamilyCode(SAMPLE);
    expect(code.articles.map((a) => a.number)).toEqual([1, 2, 7]);
    expect(code.articles[2]).toMatchObject({ title: "Front Seat" });
    expect(code.articles[2].body).toContain("oldest");
    expect(code.sentencing).toHaveLength(5);
    expect(code.sentencing[1]).toBe("Say sorry and mean it");
    expect(code.usingDefaultSentencing).toBe(false);
    expect(code.warnings).toEqual([]);
  });

  it("reads the lawmaker's own sentencing guidelines, and warns politely while articles are still blank", () => {
    const code = parseFamilyCode(readFileSync("content/family-code.md", "utf8"));
    expect(code.usingDefaultSentencing).toBe(false);
    expect(code.sentencing).toHaveLength(5);
    expect(code.sentencing.every((l) => l.trim().length > 0)).toBe(true);
    expect(code.text).not.toContain("<!--"); // comments aren't sent to Jev
  });

  it("falls back to default tiers when the sentencing levels are still placeholders", () => {
    const code = parseFamilyCode("## Article 1. Dibs\nOnly in the same room.\n\n## Sentencing Guidelines\n0. (lightest)\n1. (…)\n2. (…)\n3. (…)\n4. (heaviest)\n");
    expect(code.usingDefaultSentencing).toBe(true);
    expect(code.sentencing).toEqual(DEFAULT_SENTENCING);
    expect(code.warnings.join(" ")).toMatch(/built-in punishments/);
  });

  it("falls back when the sentencing section is missing or short", () => {
    const code = parseFamilyCode("## Article 1. Dibs\nOnly in the same room.\n\n## Sentencing Guidelines\n0. Warning\n1. Sorry\n");
    expect(code.usingDefaultSentencing).toBe(true);
    expect(parseFamilyCode("nothing here").warnings[0]).toMatch(/couldn't find any articles/);
  });
});
