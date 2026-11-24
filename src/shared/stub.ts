/**
 * GATEWAY_MODE=stub: canned connector answers so tests and off-Sprite dev never touch the network.
 *
 * A small matcher picks a handler by provider + method + path prefix. TypeSafe answers vary by
 * keywords in `state` (fixtures/typesafe/rules.json), plus a little deterministic noise so code
 * can't accidentally depend on exact probability values (real Jev drifts a few points run to run).
 */
import { readFileSync } from "node:fs";

const FIXTURES = new URL("../../fixtures/", import.meta.url);
const cache = new Map<string, unknown>();

export function fixture<T = any>(name: string): T {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")));
  return structuredClone(cache.get(name)) as T;
}

/** Every stubbed request, newest last. Tests read this to check what was sent. */
export const stubCalls: { provider: string; method: string; path: string; body: any }[] = [];

type Handler = (body: any) => unknown;
interface Route {
  provider: string;
  method: string;
  prefix: string;
  handler: Handler;
}

const routes: Route[] = [
  { provider: "typesafe", method: "POST", prefix: "/v1/systemone", handler: (b) => jevStub(b) },
  { provider: "typesafe", method: "GET", prefix: "/v1/models", handler: () => fixture("typesafe/models.json") },
  { provider: "ollama", method: "POST", prefix: "/api/chat", handler: (b) => ollamaStub(b) },
  { provider: "ollama", method: "GET", prefix: "/api/tags", handler: () => fixture("ollama/tags.json") },
];

export async function stubFetch(provider: string, input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  let body: any = undefined;
  if (typeof init.body === "string") body = JSON.parse(init.body);
  else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) body = JSON.parse(new TextDecoder().decode(init.body));
  stubCalls.push({ provider, method, path: url.pathname, body });
  if (stubCalls.length > 500) stubCalls.splice(0, stubCalls.length - 500);

  const route = routes.find((r) => r.provider === provider && r.method === method && url.pathname.startsWith(r.prefix));
  if (!route) {
    return Response.json({ error: `stub: nothing for ${provider} ${method} ${url.pathname}` }, { status: 404 });
  }
  return Response.json(route.handler(body));
}

// ---------- TypeSafe Jev ----------

interface Rules {
  noise: number;
  contempt: { high: string[]; medium: string[]; values: { high: number; medium: number; low: number } };
  case_type: { petition: string[]; declaration: string[] };
  sufficient: { both_heard: number; one_heard: number };
  justices: { close: string[]; defendant: string[]; values: { clear: number; close: number } };
  sentence: { serious: string[]; values: { default: number; serious: number } };
  new_evidence: { default: number };
  precedent: { min_shared_words: number; relevant: number; irrelevant: number };
}

const STOP = new Set("the and for that this with your are was were has have had but not his her its they them their what when who why how from into about because said says should would could will just like than then there here also very really court case judge please honor prevailed prevails".split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? []).filter((w) => !STOP.has(w)));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 0xffffffff;
}

const clamp = (x: number) => Math.min(0.99, Math.max(0.01, x));
const round2 = (x: number) => Math.round(x * 100) / 100;
const has = (text: string, words: string[]) => words.some((w) => text.includes(w.toLowerCase()));

function jevStub(req: { model?: string; state: any; questions: Record<string, any> }) {
  const rules = fixture<Rules>("typesafe/rules.json");
  const state = typeof req.state === "string" ? { text: req.state } : req.state ?? {};
  const seed = JSON.stringify(state);
  const jitter = (key: string, amount = rules.noise) => (hash(key + seed) * 2 - 1) * amount;

  const filings: { ref?: string; body?: string }[] = Array.isArray(state.filings) ? state.filings : [];
  const caseText = [state.case?.title, state.case?.claim, state.case?.relief, ...filings.map((f) => f.body), state.text]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();

  const answers: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(req.questions)) {
    if (q.type === "noul") {
      let p = 0.5;
      if (key.startsWith("contempt")) {
        const ref = key.split("_")[1]?.toUpperCase();
        const body = (filings.find((f) => f.ref?.toUpperCase() === ref)?.body ?? caseText).toLowerCase();
        const v = rules.contempt.values;
        p = has(body, rules.contempt.high) ? v.high : has(body, rules.contempt.medium) ? v.medium : v.low;
      } else if (key === "sufficient") {
        const heard: unknown[] = state.computed_facts?.parties_heard ?? [];
        p = heard.length >= 2 ? rules.sufficient.both_heard : rules.sufficient.one_heard;
      } else if (key.startsWith("relevant_")) {
        // Relevant when the past ruling shares enough real words with the current dispute.
        const ref = key.slice("relevant_".length);
        const past = (state.past_rulings ?? []).find((p: any) => p.ref === ref);
        const cur = state.current_dispute ?? state;
        const now = words([cur.case?.title, cur.case?.claim, cur.case?.relief, ...(cur.filings ?? []).map((f: any) => f.body)].join(" "));
        const parties = words(`${cur.case?.plaintiff ?? ""} ${cur.case?.defendant ?? ""}`);
        const shared = [...words(past?.question ?? "")].filter((w) => now.has(w) && !parties.has(w)).length;
        p = shared >= rules.precedent.min_shared_words ? rules.precedent.relevant : rules.precedent.irrelevant;
      } else if (key === "new_evidence") {
        p = rules.new_evidence.default;
      }
      answers[key] = { type: "noul", noul: round2(clamp(p + jitter(key))) };
    } else if (q.type === "choice") {
      const labels = Object.keys(q.criteria);
      let probs: Record<string, number>;
      if (key === "case_type") {
        const pick = has(caseText, rules.case_type.petition)
          ? "petition"
          : has(caseText, rules.case_type.declaration)
            ? "declaration"
            : "complaint";
        probs = Object.fromEntries(labels.map((l) => [l, l === pick ? 0.86 : 0.07]));
      } else if (key.startsWith("justice_") && labels.includes("plaintiff")) {
        const close = has(caseText, rules.justices.close);
        const pPlaintiff = close
          ? rules.justices.values.close + jitter(key, 0.02)
          : has(caseText, rules.justices.defendant)
            ? 1 - rules.justices.values.clear + jitter(key)
            : rules.justices.values.clear + jitter(key);
        probs = { plaintiff: round2(clamp(pPlaintiff)), defendant: round2(1 - clamp(pPlaintiff)) };
      } else {
        probs = Object.fromEntries(labels.map((l) => [l, round2(1 / labels.length)]));
      }
      const choice = labels.reduce((a, b) => (probs[b] > probs[a] ? b : a));
      answers[key] = { type: "choice", choice, confidence: probs[choice], probabilities: probs };
    } else if (q.type === "score") {
      const n = q.criteria.length;
      const s = rules.sentence;
      const target = Math.min(n - 1, (has(caseText, s.serious) ? s.values.serious : s.values.default) + jitter(key, 0.1));
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < n; i++) probabilities[String(i)] = round2(Math.max(0, 1 - Math.abs(i - target)) || 0.01);
      const legend = Object.fromEntries(q.criteria.map((c: any, i: number) => [String(i), typeof c === "string" ? c : c.what]));
      answers[key] = { type: "score", score: round2(target), confidence: 0.6, probabilities, legend };
    }
  }
  return { model: req.model === "jev-latest" || !req.model ? "jev-stub" : req.model, answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

// ---------- Ollama ----------

function ollamaStub(req: { model: string; messages: { role: string; content: string }[]; format?: unknown }) {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const line = (label: string) => lastUser.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
  const fill = (s: string) =>
    s
      .replaceAll("{{winner}}", line("Winner") || "the court")
      .replaceAll("{{loser}}", line("Other party") || "the other side")
      .replaceAll("{{percent}}", line("Confidence") || "a lot");
  if (req.format) {
    const op = fixture<{ opinion_md: string; bench_verdict: string; cited_articles: number[] }>("ollama/opinion.json");
    const content = JSON.stringify({ ...op, opinion_md: fill(op.opinion_md), bench_verdict: fill(op.bench_verdict) });
    return { model: req.model, message: { role: "assistant", content }, done: true };
  }
  const chat = fixture<{ content: string }>("ollama/chat.json");
  return { model: req.model, message: { role: "assistant", content: fill(chat.content) }, done: true };
}
