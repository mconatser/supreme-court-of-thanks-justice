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
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCourtContext } from "../src/court/context.ts";
import { FINAL_STATUSES } from "../src/court/db.ts";
import { checkExpectations } from "../test/caseExpect.ts";
import { RecessError } from "../src/shared/budget.ts";
import { loadConfig } from "../src/shared/config.ts";
import type { Ollama } from "../src/shared/ollama.ts";
import { parsePeople } from "../src/shared/people.ts";

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 1;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

// Real Jev only. Nothing else may touch real data: no Box records (and the local Family Code, so
// results don't depend on Box), no email, no voice, no checkpoints, and a throwaway data dir.
// (Before this, eval runs filed Case-0001.md versions into Box and wrote data/audio/case-1.mp3.)
const evalEnv: Record<string, string | undefined> = {
  ...process.env,
  GATEWAY_MODE: "live",
  DATA_DIR: mkdtempSync(join(tmpdir(), "fc-eval-")),
  MISTRIAL_ENABLED: "false",
  SUMMONS_TIMEOUT_MIN: "0", // one-sided cases go ahead in absentia instead of waiting
};
for (const k of ["BOX_FAMILY_CODE_FILE_ID", "BOX_RECORDS_FOLDER_ID", "BOX_BASE", "AGENTMAIL_INBOX_ID", "AGENTMAIL_BASE", "ELEVENLABS_BASE", "ELEVENLABS_VOICE_ID"]) delete evalEnv[k];
const cfg = loadConfig(evalEnv);
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
    // One-sided cases pause for a summons; with SUMMONS_TIMEOUT_MIN=0 they go ahead in absentia.
    for (let i = 0; i < 600 && !FINAL_STATUSES.has(ctx.hearings.getCase(id)!.status); i++) await new Promise((r) => setTimeout(r, 100));
    const c = ctx.hearings.getCase(id)!;
    const ev = (kind: string) => {
      const row = ctx.db.prepare("SELECT data_json FROM events WHERE case_id = ? AND kind = ? ORDER BY id DESC").get(id, kind) as any;
      return row?.data_json ? JSON.parse(row.data_json) : undefined;
    };
    const trouble = ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind IN ('court.trouble','court.recess')").get(id) as any;
    if (trouble) { results.push(`ERROR: ${trouble.message}`); failures++; continue; }

    const s = ev("screening.done");
    // One row per filing (a party can have several), so "spread" only ever means drift across runs.
    (s?.contempt ?? []).forEach((x: { author: string; p: number }, i: number) => (spreads[`contempt #${i + 1} (${x.author})`] ??= []).push(x.p));
    const suff = ev("sufficiency.done");
    if (suff) (spreads.sufficient ??= []).push(suff.p);
    const r = ev("ruling.decided");
    for (const seat of r?.decision?.seats ?? []) {
      if (seat.status === "voted") (spreads[seat.key] ??= []).push(seat.probabilities.plaintiff);
    }
    if (r?.decision && r.decision.reason !== "tie") (spreads.case_confidence ??= []).push(r.decision.caseConfidence);
    const prec = ev("precedent.checked");
    const memory = r?.decision?.seats?.find((x: any) => x.key === "justice_memory");
    const precNote = prec?.candidates?.length
      ? ` | precedent ${prec.candidates.map((x: any) => `${x.ref} ${x.p.toFixed(2)}`).join(", ")}${memory?.status === "voted" ? ` → Memory cites ${memory.cites?.join(",")}` : ""}`
      : "";
    const arts = ev("articles.checked");
    const checks = checkExpectations(ctx, id, tc.expect);
    if (checks.some((x) => !x.ok)) failures++;
    results.push(
      `${c.status}${r?.winner ? ` → ${r.winner}` : ""}${r?.decision ? ` (${r.decision.vote})` : ""} [${c.type}]${arts ? ` | articles ${arts.allowed.join(",") || "none"}` : ""}${precNote}\n` +
        checks.map((x) => `      ${x.ok ? "✓" : "✗"} ${x.name}: expected ${x.want}, got ${x.got}`).join("\n"),
    );
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
