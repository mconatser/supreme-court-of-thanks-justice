/**
 * npm run eval:live [-- --runs 2] [-- --only hot-dog]
 *
 * Runs test/cases/*.json against REAL Jev (inside a Sprite) to tune thresholds and decide when to
 * pin JEV_MODEL. Not part of `npm test`. Uses a throwaway in-memory DB and skips Ollama (template
 * opinions), so it costs only Jev calls: about 1 per contempt case and 3 per other case, per run.
 *
 * Jev drifts a few points between identical runs, so checks are on outcomes and bands, never
 * exact values. With --runs > 1 it reports the spread.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createCourtContext } from "../src/court/context.ts";
import { RecessError } from "../src/shared/budget.ts";
import { loadConfig } from "../src/shared/config.ts";
import type { Ollama } from "../src/shared/ollama.ts";
import { parsePeople } from "../src/shared/people.ts";

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 1;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

const cfg = loadConfig({ ...process.env, GATEWAY_MODE: "live" });
const files = readdirSync("test/cases").filter((f) => f.endsWith(".json") && (!only || f.includes(only))).sort();
const cases = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(`test/cases/${f}`, "utf8")) }));
const aliases = [...new Set(cases.flatMap((c: any) => [c.plaintiff, c.defendant]))];
const people = parsePeople(aliases.map((a, i) => ({ id: `eval${i}`, alias: a, role: "kid" })));
const noOllama: Ollama = {
  chat: async () => { throw new RecessError("ollama"); },
  chatJson: async () => { throw new RecessError("ollama"); },
};

let failures = 0;
for (const tc of cases) {
  const results: string[] = [];
  const spreads: Record<string, number[]> = {};
  for (let run = 0; run < runs; run++) {
    const ctx = createCourtContext(cfg, people, { dbPath: ":memory:", ollama: noOllama, log: () => {} });
    const { id } = ctx.hearings.file({
      plaintiff: tc.plaintiff, defendant: tc.defendant, title: tc.title, claim: tc.claim, relief: tc.relief,
      filedBy: "pro_se", filings: tc.filings ?? [],
    });
    await ctx.hearings.start(id);
    const c = ctx.hearings.getCase(id)!;
    const ev = (kind: string) => {
      const row = ctx.db.prepare("SELECT data_json FROM events WHERE case_id = ? AND kind = ? ORDER BY id DESC").get(id, kind) as any;
      return row?.data_json ? JSON.parse(row.data_json) : undefined;
    };
    const trouble = ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind IN ('court.trouble','court.recess')").get(id) as any;
    if (trouble) { results.push(`ERROR: ${trouble.message}`); continue; }

    const s = ev("screening.done");
    // One row per filing (a party can have several), so "spread" only ever means drift across runs.
    (s?.contempt ?? []).forEach((x: { author: string; p: number }, i: number) => (spreads[`contempt #${i + 1} (${x.author})`] ??= []).push(x.p));
    const suff = ev("sufficiency.done");
    if (suff) (spreads.sufficient ??= []).push(suff.p);
    const r = ev("ruling.decided");
    for (const seat of r?.decision?.seats ?? []) {
      if (seat.status === "voted") (spreads[seat.key] ??= []).push(seat.probabilities.plaintiff);
    }
    if (r?.decision) (spreads.case_confidence ??= []).push(r.decision.caseConfidence);
    results.push(`${c.status}${r?.winner ? ` → ${r.winner}` : ""} [type ${c.type}]`);

    const exp = tc.expect ?? {};
    const ok =
      (exp.contempt === undefined || (c.status === "contempt") === exp.contempt) &&
      (exp.status === undefined || c.status === exp.status);
    if (!ok) failures++;
    ctx.db.close();
  }

  console.log(`\n${tc.file}  (expect ${JSON.stringify(tc.expect)})`);
  results.forEach((r, i) => console.log(`  run ${i + 1}: ${r}`));
  for (const [k, xs] of Object.entries(spreads)) {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    console.log(`  ${k.padEnd(28)} ${xs.map((x) => x.toFixed(2)).join(" ")}${xs.length > 1 ? `   (spread ${(hi - lo).toFixed(2)})` : ""}`);
  }
}
console.log(`\n${failures ? `${failures} run(s) didn't match expectations.` : "All runs matched expectations."}`);
process.exit(failures ? 1 : 0);
