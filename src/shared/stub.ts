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
export const stubCalls: { provider: string; method: string; path: string; body: any; form?: Record<string, string> }[] = [];

interface StubRequest {
  url: URL;
  method: string;
  body: any;
  /** Multipart fields (files read as text), in the order they were sent. */
  form?: [string, string][];
}
type Handler = (req: StubRequest) => unknown | Response | Promise<unknown | Response>;
interface Route {
  provider: string;
  method: string;
  /** A path prefix, or a regex for paths with ids in them. */
  path: string | RegExp;
  handler: Handler;
}

const routes: Route[] = [
  { provider: "typesafe", method: "POST", path: "/v1/systemone", handler: (r) => jevStub(r.body) },
  { provider: "typesafe", method: "GET", path: "/v1/models", handler: () => fixture("typesafe/models.json") },
  { provider: "ollama", method: "POST", path: "/api/chat", handler: (r) => ollamaStub(r.body) },
  { provider: "ollama", method: "GET", path: "/api/tags", handler: () => fixture("ollama/tags.json") },
  { provider: "box", method: "GET", path: /^\/2\.0\/files\/[^/]+\/content$/, handler: (r) => stubBox.download(r) },
  { provider: "box", method: "GET", path: /^\/2\.0\/files\/[^/]+$/, handler: (r) => stubBox.info(r) },
  { provider: "box", method: "POST", path: /^\/upload\/files\/content$/, handler: (r) => stubBox.upload(r) },
  { provider: "box", method: "POST", path: /^\/upload\/files\/[^/]+\/content$/, handler: (r) => stubBox.uploadVersion(r) },
  { provider: "agentmail", method: "GET", path: "/v0/auth/me", handler: () => ({ credential_kind: "api_key", credential_scope: "inbox" }) },
  { provider: "agentmail", method: "POST", path: /^\/v0\/inboxes\/[^/]+\/messages\/send$/, handler: (r) => stubMail.send(r) },
  { provider: "elevenlabs_tts", method: "POST", path: /^\/v1\/text-to-speech\/[^/]+$/, handler: (r) => stubTts.speak(r) },
];

export async function stubFetch(provider: string, input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  let body: any = undefined;
  let form: [string, string][] | undefined;
  if (typeof init.body === "string") body = JSON.parse(init.body);
  else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) body = JSON.parse(new TextDecoder().decode(init.body));
  else if (init.body instanceof FormData) {
    form = [];
    for (const [k, v] of init.body.entries()) form.push([k, typeof v === "string" ? v : await v.text()]);
  }
  stubCalls.push({ provider, method, path: url.pathname, body, form: form && Object.fromEntries(form) });
  if (stubCalls.length > 500) stubCalls.splice(0, stubCalls.length - 500);

  const route = routes.find(
    (r) =>
      r.provider === provider &&
      r.method === method &&
      (typeof r.path === "string" ? url.pathname.startsWith(r.path) : r.path.test(url.pathname)),
  );
  if (!route) {
    return Response.json({ error: `stub: nothing for ${provider} ${method} ${url.pathname}` }, { status: 404 });
  }
  const out = await route.handler({ url, method, body, form });
  return out instanceof Response ? out : Response.json(out);
}

// ---------- Box: a tiny in-memory Box ----------

interface StubFile {
  id: string;
  name: string;
  parent: string;
  versions: string[]; // contents, oldest first
}

export const stubBox = {
  files: new Map<string, StubFile>(),
  nextId: 1000,
  /** Make the next N requests fail with this status (for outage tests). */
  failNext: 0,
  failStatus: 503,

  reset() {
    this.files.clear();
    this.failNext = 0;
  },
  put(id: string, name: string, content: string, parent = "0") {
    const f = this.files.get(id);
    if (f) f.versions.push(content);
    else this.files.set(id, { id, name, parent, versions: [content] });
  },
  latest(id: string) {
    const f = this.files.get(id);
    return f?.versions.at(-1);
  },
  inFolder(parent: string) {
    return [...this.files.values()].filter((f) => f.parent === parent);
  },
  failing(): Response | null {
    if (this.failNext > 0) {
      this.failNext--;
      return Response.json({ type: "error", status: this.failStatus }, { status: this.failStatus });
    }
    return null;
  },
  describe(f: StubFile) {
    return { type: "file", id: f.id, name: f.name, file_version: { type: "file_version", id: `${f.id}-v${f.versions.length}` }, modified_at: "2026-11-24T00:00:00-08:00" };
  },
  info(r: StubRequest) {
    const fail = this.failing();
    if (fail) return fail;
    const f = this.files.get(r.url.pathname.split("/")[3]);
    return f ? this.describe(f) : Response.json({ type: "error", status: 404, code: "not_found" }, { status: 404 });
  },
  download(r: StubRequest) {
    const fail = this.failing();
    if (fail) return fail;
    const f = this.files.get(r.url.pathname.split("/")[3]);
    return f ? new Response(f.versions.at(-1)!, { headers: { "content-type": "application/octet-stream" } }) : new Response("", { status: 404 });
  },
  upload(r: StubRequest) {
    const fail = this.failing();
    if (fail) return fail;
    const fields = r.form ?? [];
    if (fields[0]?.[0] !== "attributes") return Response.json({ code: "bad_request", message: "attributes must come first" }, { status: 400 });
    const attrs = JSON.parse(fields[0][1]);
    const content = fields.find(([k]) => k === "file")?.[1] ?? "";
    const clash = this.inFolder(attrs.parent.id).find((f) => f.name === attrs.name);
    if (clash) {
      return Response.json(
        { type: "error", status: 409, code: "item_name_in_use", context_info: { conflicts: { type: "file", id: clash.id, name: clash.name } } },
        { status: 409 },
      );
    }
    const id = String(this.nextId++);
    this.files.set(id, { id, name: attrs.name, parent: attrs.parent.id, versions: [content] });
    return { total_count: 1, entries: [this.describe(this.files.get(id)!)] };
  },
  uploadVersion(r: StubRequest) {
    const fail = this.failing();
    if (fail) return fail;
    const f = this.files.get(r.url.pathname.split("/")[3]);
    if (!f) return Response.json({ status: 404, code: "not_found" }, { status: 404 });
    f.versions.push((r.form ?? []).find(([k]) => k === "file")?.[1] ?? "");
    return { total_count: 1, entries: [this.describe(f)] };
  },
};

// ---------- AgentMail ----------

export const stubMail = {
  sent: [] as { inbox: string; to: string[]; subject: string; text: string; html?: string }[],
  reset() {
    this.sent = [];
  },
  send(r: StubRequest) {
    const inbox = decodeURIComponent(r.url.pathname.split("/")[3]);
    this.sent.push({ inbox, ...r.body });
    return { message_id: `msg_${this.sent.length}`, thread_id: `thr_${this.sent.length}` };
  },
};

// ---------- ElevenLabs text to speech ----------

/** A few bytes that start like an MP3 frame; enough for tests. */
export const STUB_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64]);

export const stubTts = {
  requests: [] as { voice: string; text: string; model_id?: string }[],
  failNext: 0,
  reset() {
    this.requests = [];
    this.failNext = 0;
  },
  speak(r: StubRequest) {
    if (this.failNext > 0) {
      this.failNext--;
      return Response.json({ detail: { status: "endpoint_not_supported" } }, { status: 400 });
    }
    this.requests.push({ voice: r.url.pathname.split("/").at(-1)!, ...r.body });
    return new Response(STUB_MP3, { headers: { "content-type": "audio/mpeg" } });
  },
};

// ---------- TypeSafe Jev ----------

interface Rules {
  noise: number;
  contempt: { high: string[]; medium: string[]; values: { high: number; medium: number; low: number } };
  case_type: { petition: string[]; declaration: string[] };
  sufficient: { both_heard: number; one_heard: number };
  justices: { close: string[]; defendant: string[]; values: { clear: number; close: number } };
  sentence: { serious: string[]; values: { default: number; serious: number } };
  new_evidence: { default: number; fresh: number; keywords: string[] };
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
        const body = String(state.new_filing?.body ?? "").toLowerCase();
        p = has(body, rules.new_evidence.keywords) ? rules.new_evidence.fresh : rules.new_evidence.default;
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
  const props = Object.keys((req.format as { properties?: object } | undefined)?.properties ?? {});
  if (props.includes("argument")) {
    return { model: req.model, message: { role: "assistant", content: JSON.stringify({ argument: "It's only fair to take turns, and I was there first." }) }, done: true };
  }
  if (props.includes("lesson")) {
    return { model: req.model, message: { role: "assistant", content: JSON.stringify({ lesson: "Justice Heart cares about who did the work." }) }, done: true };
  }
  if (req.format) {
    const op = fixture<{ opinion_md: string; bench_verdict: string; cited_articles: number[] }>("ollama/opinion.json");
    const content = JSON.stringify({ ...op, opinion_md: fill(op.opinion_md), bench_verdict: fill(op.bench_verdict) });
    return { model: req.model, message: { role: "assistant", content }, done: true };
  }
  const chat = fixture<{ content: string }>("ollama/chat.json");
  return { model: req.model, message: { role: "assistant", content: fill(chat.content) }, done: true };
}
