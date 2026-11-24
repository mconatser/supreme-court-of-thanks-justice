/**
 * mock_trial: rehearse up to 3 drafts against the court's own panel questions (shared/panel.ts).
 *
 * For each draft: a hypothetical record (the draft as the client's argument, plus an LLM-written
 * steelman of the other side), the court's Family Code and relevant precedent, then one Jev
 * request with the justices plus a contempt check on the draft. Predicted win % = the mean, across
 * justices, of the probability each gives the client's side. Jev drifts a few points between
 * runs, so treat predictions as a guide, not a promise.
 */
import { z } from "zod";
import type { Jev } from "../shared/jev.ts";
import type { Ollama } from "../shared/ollama.ts";
import {
  band,
  buildState,
  contemptQuestion,
  justiceQuestion,
  keepRelevant,
  precedentRelevanceQuestion,
  type JusticeKey,
  type Precedent,
} from "../shared/panel.ts";
import type { CourtClient } from "./court.ts";

export const MAX_DRAFTS = 3;
export const MAX_MOCK_CALLS = 2;

export interface MockFacts {
  client: string;
  opponent: string;
  title: string;
  claim: string;
  relief: string;
}

export interface DraftResult {
  draft: number; // 1-based
  argument: string;
  winPct: number;
  justices: { justice: string; clientPct: number }[];
  contempt: { p: number; band: string };
  warning?: string;
}

export interface MockResult {
  opposingArgument: string;
  precedentUsed: string[];
  drafts: DraftResult[];
  best: number | null;
}

const NAMES: Record<JusticeKey, string> = { justice_letter: "the rules as written", justice_heart: "fairness", justice_memory: "past rulings" };

export async function steelman(ollama: Ollama, facts: MockFacts, opposingView: string, code: string): Promise<string> {
  const schema = z.object({ argument: z.string().min(1) });
  const out = await ollama.chatJson(schema, {
    think: false,
    messages: [
      {
        role: "system",
        content:
          "You argue the OTHER side of a kids' family-court case, as strongly and fairly as you can, in at most 80 words. PG and kind. Use the Family Code when it helps. Never bribe or flatter the court. Reply only with JSON: {\"argument\": string}.",
      },
      {
        role: "user",
        content: `Family Code:\n${code.slice(0, 6000)}\n\nCase: ${facts.title}\n${facts.client} says: ${facts.claim}\n${facts.client} wants: ${facts.relief}\nWhat ${facts.opponent} probably thinks: ${opposingView}\n\nWrite ${facts.opponent}'s strongest argument.`,
      },
    ],
  });
  return out.argument.slice(0, 800);
}

export async function mockTrial(
  deps: { jev: Jev; ollama: Ollama; court: CourtClient },
  facts: MockFacts,
  drafts: string[],
  opposingView: string,
): Promise<MockResult> {
  const law = await deps.court.lawLibrary();
  const opposingArgument = await steelman(deps.ollama, facts, opposingView, law.text);

  // Precedent, filtered for relevance exactly like the court does (one batched request).
  const candidates = await deps.court.precedent(`${facts.title} ${facts.claim} ${facts.relief}`);
  let precedent: Precedent[] = [];
  if (candidates.length) {
    const questions = Object.fromEntries(candidates.map((p) => [`relevant_${p.ref}`, precedentRelevanceQuestion(p.ref!)]));
    const state = {
      current_dispute: buildState({
        case: { number: 0, title: facts.title, type: null, plaintiff: facts.client, defendant: facts.opponent, claim: facts.claim, relief: facts.relief },
        filings: [{ author: facts.opponent, kind: "response", body: opposingArgument }],
      }),
      past_rulings: candidates,
    };
    const res = await deps.jev.ask(state, questions);
    precedent = keepRelevant(candidates, res.answers as Record<string, { noul: number }>).kept;
  }

  const c = { plaintiff: facts.client, defendant: facts.opponent, relief: facts.relief };
  const justices: JusticeKey[] = precedent.length ? ["justice_letter", "justice_heart", "justice_memory"] : ["justice_letter", "justice_heart"];
  const results: DraftResult[] = [];
  for (const [i, argument] of drafts.slice(0, MAX_DRAFTS).entries()) {
    const questions: Record<string, ReturnType<typeof justiceQuestion> | ReturnType<typeof contemptQuestion>> = {
      contempt_F1: contemptQuestion("F1"),
    };
    for (const k of justices) questions[k] = justiceQuestion(k, c);
    const state = buildState({
      case: { number: 0, title: facts.title, type: null, plaintiff: facts.client, defendant: facts.opponent, claim: facts.claim, relief: facts.relief },
      filings: [
        { ref: "F1", author: facts.client, kind: "argument", body: `${facts.claim}\n\n${argument}` },
        { ref: "F2", author: facts.opponent, kind: "response", body: opposingArgument },
      ],
      familyCode: law.text,
      precedent,
      computedFacts: { filings_count: 2, parties_heard: [facts.client, facts.opponent] },
    });
    const res = await deps.jev.ask(state, questions);
    const a = res.answers as Record<string, any>;
    const per = justices.map((k) => ({ justice: NAMES[k], clientPct: Math.round(Number(a[k]?.probabilities?.plaintiff ?? 0) * 100) }));
    const winPct = Math.round(per.reduce((s, x) => s + x.clientPct, 0) / per.length);
    const p = Number(a.contempt_F1?.noul ?? 0);
    results.push({
      draft: i + 1,
      argument,
      winPct,
      justices: per,
      contempt: { p, band: band(p) },
      warning: band(p) === "yes" ? "This draft would be held in contempt of court. Don't file it!" : band(p) === "unsure" ? "The court might think this draft is trying to sway it." : undefined,
    });
  }
  const safe = results.filter((r) => r.contempt.band !== "yes");
  const best = safe.length ? safe.reduce((a, b) => (b.winPct > a.winPct ? b : a)).draft : null;
  return { opposingArgument, precedentUsed: precedent.map((p) => p.case), drafts: results, best };
}
