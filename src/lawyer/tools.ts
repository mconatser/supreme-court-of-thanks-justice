/**
 * The lawyer's tools (SPEC §9.3). The rules that matter are enforced here, in code, not just
 * in the prompt: a mock trial before filing, and an explicit Yes from the client (a button press)
 * for exactly the filing that gets filed.
 */
import { z } from "zod";
import type { Jev } from "../shared/jev.ts";
import type { Ollama } from "../shared/ollama.ts";
import type { CourtClient } from "./court.ts";
import type { LawyerDB } from "./db.ts";
import { addLesson, type Outcome } from "./memory.ts";
import { MAX_DRAFTS, MAX_MOCK_CALLS, mockTrial, type MockResult } from "./mock.ts";

export interface Filing {
  defendant: string;
  title: string;
  claim: string;
  relief: string;
  argument: string;
}

export interface MatterState {
  ref: string;
  mockCalls: number;
  mock: MockResult | null;
  /** The filing the client pressed Yes on. */
  confirmed: Filing | null;
  filedNumber: number | null;
}

export interface Pending {
  question: string;
  kind: "question" | "confirm_filing";
  filing?: Filing;
}

export interface ToolOutcome {
  result: unknown;
  /** Keep following this court case in the background (the hearing paused). */
  follow?: number;
  /** Plain words for "counsel's notes". */
  note: string;
  pause?: Pending;
  ok: boolean;
}

export interface ToolDeps {
  db: LawyerDB;
  jev: Jev;
  ollama: Ollama;
  court: CourtClient;
  client: string;
  /** Live notes while a long tool runs (watch_hearing). */
  onNote: (note: string) => void;
  /** The lawyer persona (content/lawyer-persona.md), for counsel's own voice. */
  persona?: () => string;
  /** Court cases counsel has already chimed in on (once per case, across every watcher). */
  remarked?: Set<number>;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description: string) => ({ type: "string", description });
const FILING_PROPS = {
  defendant: str("Who the case is against: an exact alias from the court's party list"),
  title: str("A short case name, e.g. 'The Great Front Seat Dispute'"),
  claim: str("What happened, in the client's words, truthfully (max 1500 characters)"),
  relief: str("What the client wants the court to do (max 300 characters)"),
  argument: str("The argument to file: the winning mock-trial draft (max 1500 characters)"),
};

export const TOOL_DEFS = [
  fn("read_family_code", "Read the Family Code (the house laws) and the sentencing guidelines from the court's law library.", {}),
  fn("list_parties", "The people your client can bring a case against: exact aliases and roles from the court's list.", {}),
  fn("search_precedent", "Search the court's past rulings and landmark cases.", { query: str("What the dispute is about") }, ["query"]),
  fn(
    "ask_client",
    "Ask your client a question and wait for the answer. To get permission to file, include confirm_filing with the exact filing; the client answers with a Yes or No button.",
    { question: str("The question, in plain friendly words"), confirm_filing: { type: "object", description: "The exact filing to approve", properties: FILING_PROPS } },
    ["question"],
  ),
  fn(
    "mock_trial",
    `Rehearse up to ${MAX_DRAFTS} argument drafts in front of the court's real panel questions (max ${MAX_MOCK_CALLS} mock trials per case). Returns each draft's predicted win %.`,
    {
      defendant: FILING_PROPS.defendant,
      title: FILING_PROPS.title,
      claim: FILING_PROPS.claim,
      relief: FILING_PROPS.relief,
      drafts: { type: "array", items: { type: "string" }, description: `1 to ${MAX_DRAFTS} different argument drafts` },
      opposing_view: str("What the other side will probably say"),
    },
    ["defendant", "title", "claim", "relief", "drafts", "opposing_view"],
  ),
  fn(
    "file_case",
    "File the case with the court. Only after a mock_trial AND after the client pressed Yes on this exact filing via ask_client.confirm_filing.",
    { type: str("complaint, petition or declaration (the court decides in the end)"), ...FILING_PROPS },
    ["defendant", "title", "claim", "relief", "argument"],
  ),
  fn("watch_hearing", "Watch the court's hearing for a filed case until the ruling, and learn from the result.", { number: { type: "integer", description: "The court case number" } }, ["number"]),
];

const FilingSchema = z.object({
  defendant: z.string().trim().min(1),
  title: z.string().trim().min(1).max(120),
  claim: z.string().trim().min(5).max(1500),
  relief: z.string().trim().min(2).max(300),
  argument: z.string().trim().max(1500).default(""),
});

/** Below this, the best mock-trial draft is a long shot. */
export const WEAK_CASE_PCT = 50;
export const DEFAULT_WEAK_CASE_LINE = "This one's a long shot, boss.";

/** The best non-contempt draft's predicted win %, or null before any mock trial. */
export function bestWinPct(state: Pick<MatterState, "mock">): number | null {
  const m = state.mock;
  if (!m || m.best == null) return null;
  return m.drafts.find((d) => d.draft === m.best)?.winPct ?? null;
}

/** The persona's "When the case is weak" line (content/lawyer-persona.md), so it stays swappable. */
export function weakCaseLine(persona: string): string {
  return personaLine(persona, "When the case is weak", DEFAULT_WEAK_CASE_LINE);
}

const norm = (f: Filing) => JSON.stringify([f.defendant, f.title, f.claim, f.relief, f.argument].map((x) => x.trim().replace(/\s+/g, " ")));
const fail = (note: string, error: string): ToolOutcome => ({ ok: false, note, result: { error } });

export async function runTool(name: string, args: Record<string, unknown>, state: MatterState, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "read_family_code": {
        const law = await deps.court.lawLibrary();
        return {
          ok: true,
          note: `Reading the Family Code (${law.articles.length} articles)…`,
          result: { articles: law.articles, sentencing_guidelines: law.sentencing, notes: law.warnings },
        };
      }
      case "list_parties": {
        const parties = await deps.court.parties();
        const others = parties.filter((p) => p.alias.toLowerCase() !== deps.client.toLowerCase());
        return {
          ok: true,
          note: `Checking who's on the court's list (${others.length} people)…`,
          result: { client: deps.client, can_be_defendant: others.map((p) => ({ alias: p.alias, role: p.role })) },
        };
      }
      case "search_precedent": {
        const q = String(args.query ?? "");
        const found = await deps.court.precedent(q);
        return {
          ok: true,
          note: `Looking up past cases about “${q.slice(0, 60)}”…`,
          result: { precedent: found.map(({ case: c, question, outcome, vote }) => ({ case: c, question, outcome, vote })) },
        };
      }
      case "ask_client": {
        const question = String(args.question ?? "").trim() || "What would you like to do?";
        if (args.confirm_filing && typeof args.confirm_filing === "object") {
          const parsed = FilingSchema.safeParse(args.confirm_filing);
          if (!parsed.success) return fail("Tried to ask for permission to file, but the filing wasn't complete.", `confirm_filing is incomplete: ${parsed.error.issues[0]?.message}`);
          // A long shot gets said out loud, in the lawyer's own words, before the recommendation.
          const best = bestWinPct(state);
          const line = best !== null && best < WEAK_CASE_PCT ? weakCaseLine(deps.persona?.() ?? "") : null;
          const asked = line && !question.toLowerCase().includes(line.toLowerCase().replace(/[.!]+$/, "")) ? `${line} ${question}` : question;
          return {
            ok: true,
            note: line ? `Asking you: ready to file? (a long shot: ${best}%)` : "Asking you: ready to file?",
            result: { asked: true },
            pause: { question: asked, kind: "confirm_filing", filing: parsed.data },
          };
        }
        return { ok: true, note: `Asking you: “${question.slice(0, 80)}”`, result: { asked: true }, pause: { question, kind: "question" } };
      }
      case "mock_trial": {
        if (state.mockCalls >= MAX_MOCK_CALLS) return fail("Wanted another mock trial, but already did two.", `Only ${MAX_MOCK_CALLS} mock trials per case. Pick the best draft so far.`);
        const drafts = (Array.isArray(args.drafts) ? args.drafts : []).map(String).filter((d) => d.trim());
        if (!drafts.length) return fail("Tried a mock trial with no drafts.", "Give 1 to 3 drafts.");
        if (drafts.length > MAX_DRAFTS) return fail(`Tried ${drafts.length} drafts; the limit is ${MAX_DRAFTS}.`, `At most ${MAX_DRAFTS} drafts per mock trial.`);
        const f = FilingSchema.omit({ argument: true }).safeParse(args);
        if (!f.success) return fail("Tried a mock trial without the case details.", f.error.issues[0]?.message ?? "missing case details");
        const parties = await deps.court.parties();
        const opp = parties.find((p) => p.alias.toLowerCase() === f.data.defendant.toLowerCase());
        if (!opp) {
          const names = parties.filter((p) => p.alias.toLowerCase() !== deps.client.toLowerCase()).map((p) => `${p.alias} (${p.role})`);
          return fail(
            "Tried a mock trial against someone not on the court's list.",
            `"${f.data.defendant}" isn't on the court's list. The defendant must be one of: ${names.join(", ")}. If you're not sure which, ask_client before trying again. (This didn't use up a mock trial.)`,
          );
        }
        if (opp.alias.toLowerCase() === deps.client.toLowerCase()) return fail("Almost sued our own client!", "The defendant can't be your client.");
        state.mockCalls++;
        const res = await mockTrial(deps, { client: deps.client, opponent: opp.alias, title: f.data.title, claim: f.data.claim, relief: f.data.relief }, drafts, String(args.opposing_view ?? ""));
        state.mock = res;
        const summary = res.drafts.map((d) => `draft ${d.draft}: ${d.winPct}%${d.contempt.band === "yes" ? " (contempt!)" : ""}`).join(", ");
        return { ok: true, note: `Mock trial: ${summary}.`, result: res };
      }
      case "file_case": {
        if (state.filedNumber) return fail("Tried to file twice.", `Already filed as case #${state.filedNumber}. Use watch_hearing.`);
        if (!state.mock) return fail("Wanted to file, but hadn't practiced yet.", "Run a mock_trial before filing.");
        const parsed = FilingSchema.safeParse(args);
        if (!parsed.success) return fail("Tried to file an incomplete case.", parsed.error.issues[0]?.message ?? "incomplete filing");
        if (!state.confirmed) return fail("Wanted to file, but the client hasn't said yes.", "Ask the client with ask_client and confirm_filing, and wait for them to press Yes.");
        if (norm(parsed.data) !== norm(state.confirmed)) {
          return fail("The filing changed after the client approved it.", "The client approved a different filing. Ask them again with the exact filing.");
        }
        const draft = state.mock.drafts.find((d) => d.argument.trim() === parsed.data.argument.trim());
        if (draft?.contempt.band === "yes") return fail("Refused to file a draft the court would hold in contempt.", "That draft would be held in contempt. Choose another.");
        const filed = await deps.court.fileCase({ plaintiff: deps.client, ...parsed.data });
        const best = state.mock.drafts.find((d) => d.draft === state.mock!.best);
        const predicted = (draft ?? best)?.winPct ?? null;
        state.filedNumber = filed.number;
        state.confirmed = null;
        deps.db
          .prepare("INSERT OR REPLACE INTO cases(case_ref, title, court_case_number, predicted, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(state.ref, parsed.data.title, filed.number, predicted != null ? predicted / 100 : null, Date.now());
        return { ok: true, note: `Filed! Case #${String(filed.number).padStart(4, "0")} is on the docket.`, result: { filed: true, number: filed.number } };
      }
      case "watch_hearing": {
        const n = Number(args.number ?? state.filedNumber);
        if (!Number.isInteger(n) || n <= 0) return fail("Wanted to watch a hearing without a case number.", "Give the case number.");
        deps.onNote(`Watching the hearing for case #${String(n).padStart(4, "0")}…`);
        const { view, paused } = await followHearing(deps, n, { stopOnSummons: true });
        if (!view.final) {
          const waiting = (view.summons ?? []).filter((s: { status: string }) => s.status === "pending").map((s: { party: string }) => s.party);
          return {
            ok: true,
            // Counsel keeps following in the background, and reports back when the court rules.
            follow: n,
            note: paused || waiting.length ? `The court summoned ${waiting.join(" and ") || "the other side"}; the hearing waits for their testimony. I'll keep an eye on it.` : "The hearing is still going. I'll keep an eye on it.",
            result: {
              done: false,
              status: view.status,
              waiting_for_testimony_from: waiting,
              advice: "Tell your client the court is waiting for testimony. You'll keep watching in the background and report the ruling when it comes.",
            },
          };
        }
        const settled = await settleCase(deps, n, view);
        return {
          ok: true,
          note: settled.fresh ? settled.note : "The ruling is in (already recorded).",
          result: { done: true, ...settled.result },
        };
      }
      default:
        return fail(`Tried a tool that doesn't exist (${name}).`, `Unknown tool ${name}.`);
    }
  } catch (err) {
    return fail(`The ${name} tool hit a snag.`, (err as Error).message);
  }
}

const view0Title = (v: { title?: string; claim?: string }) => `${v.title ?? ""}: ${v.claim ?? ""}`;

/**
 * Follow a hearing on the court's stream: every event goes into counsel's notes, and counsel may
 * mutter one line while the justices confer. With stopOnSummons, a newly issued summons ends the
 * follow (the hearing pauses for testimony). Returns the case as the court sees it afterwards.
 */
export async function followHearing(
  deps: ToolDeps,
  n: number,
  opts: { stopOnSummons: boolean; maxMs?: number; signal?: AbortSignal },
): Promise<{ view: any; paused: boolean }> {
  const before = await deps.court.getCase(n);
  // Paused means a summons is still unanswered (answering one is instant; the status catches up).
  let paused = opts.stopOnSummons && !before.final && (before.summons ?? []).some((s: { status: string }) => s.status === "pending");
  // Events up to here are history: the stream replays them first.
  const seen = Number(before.lastEventId ?? 0);
  let remark: Promise<unknown> | null = null;
  const onEvent = (e: { id: number; kind: string; message: string }) => {
    deps.onNote(`Court: ${e.message}`);
    if (!remark && /deliberation\.started$/.test(e.kind) && e.id > seen && !deps.remarked?.has(n)) {
      deps.remarked?.add(n);
      remark = interject(deps, view0Title(before), e.message)
        .then(async (line) => {
          if (!line) return;
          await deps.court.remark(n, line);
          deps.onNote(`Counsel, under their breath: “${line}”`);
        })
        .catch(() => {});
    }
  };
  if (!paused) {
    await deps.court.watch(n, onEvent, {
      maxMs: opts.maxMs,
      signal: opts.signal,
      stopOn: opts.stopOnSummons ? (e) => (e.kind === "summons.issued" && e.id > seen ? (paused = true) : false) : undefined,
    });
  }
  if (remark) await remark;
  return { view: await deps.court.getCase(n), paused };
}

export function outcomeOf(view: any, client: string): Outcome {
  const r = view.ruling ?? {};
  if (r.outcome === "contempt") return "contempt";
  if (r.outcome === "compromise") return "compromise";
  return r.winner?.toLowerCase() === client.toLowerCase() ? "won" : "lost";
}

/**
 * Record a finished case once: outcome vs. prediction, and a one-line lesson. Safe to call from
 * both the tool and a background follower (only the first one writes).
 */
export async function settleCase(deps: ToolDeps, n: number, view: any) {
  const r = view.ruling ?? {};
  const outcome = outcomeOf(view, deps.client);
  const changes = deps.db.prepare("UPDATE cases SET outcome = ?, vote = ? WHERE court_case_number = ? AND outcome IS NULL").run(outcome, r.vote ?? null, n).changes;
  const predicted = (deps.db.prepare("SELECT predicted FROM cases WHERE court_case_number = ?").get(n) as { predicted: number | null } | undefined)?.predicted ?? null;
  let lesson: string | null = null;
  if (changes) {
    lesson = await writeLesson(deps.ollama, { title: view.title, outcome, predicted, seats: r.seats, opinion: r.opinionMd }).catch(() => null);
    if (lesson) addLesson(deps.db, lesson);
  }
  const said = outcome === "won" ? "we won" : outcome === "lost" ? "we lost" : outcome === "compromise" ? "a compromise" : "contempt of court";
  return {
    fresh: changes > 0,
    outcome,
    predicted,
    lesson,
    note: `Ruling: ${said}${r.vote ? ` (${r.vote})` : ""}.${lesson ? ` Lesson: ${lesson}` : ""}`,
    result: { outcome, winner: r.winner ?? null, vote: r.vote ?? null, confidencePct: r.confidencePct ?? null, sentence: r.sentence?.text ?? null, benchVerdict: r.benchVerdict ?? null, lesson },
  };
}

/** A labelled line from the persona file ("**What they say when they win:** \"…\""), or a default. */
export function personaLine(persona: string, label: string, fallback: string): string {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = persona.match(new RegExp(`\\*\\*${esc}:\\*\\*\\s*"([^"\\n]+)"`, "i"));
  return m?.[1]?.trim() || fallback;
}

/** One short, PG line supporting the client, in the lawyer's own voice. Never addressed to the judge. */
async function interject(deps: ToolDeps, caseLine: string, moment: string): Promise<string | null> {
  const persona = deps.persona?.() ?? "";
  const out = await deps.ollama.chatJson(z.object({ remark: z.string() }), {
    think: false,
    messages: [
      {
        role: "system",
        content: `${persona}\n\nWrite ONE short line (at most 12 words) you'd mutter to your client, ${deps.client}, while the justices confer. Supportive and funny, PG. Don't talk to the judge, don't ask the court for anything, never mention gifts or food for the court. Reply only with JSON: {"remark": string}.`,
      },
      { role: "user", content: `Case: ${caseLine}\nWhat just happened: ${moment}` },
    ],
  });
  const line = out.remark.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim();
  return line ? line.slice(0, 140) : null;
}

async function writeLesson(ollama: Ollama, o: { title: string; outcome: Outcome; predicted: number | null | undefined; seats: unknown; opinion?: string }) {
  const out = await ollama.chatJson(z.object({ lesson: z.string().min(1) }), {
    think: false,
    messages: [
      { role: "system", content: 'You are a kids\' family-court lawyer writing a one-line lesson (under 20 words) for your future self about how this court decides. Reply only with JSON: {"lesson": string}.' },
      {
        role: "user",
        content: `Case: ${o.title}\nResult for our client: ${o.outcome}\nWe predicted: ${o.predicted != null ? Math.round(o.predicted * 100) + "%" : "unknown"}\nJustices: ${JSON.stringify(o.seats)}\nOpinion: ${(o.opinion ?? "").slice(0, 1200)}`,
      },
    ],
  });
  return out.lesson.replace(/\s+/g, " ").trim().slice(0, 200);
}
