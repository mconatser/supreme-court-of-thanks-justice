/**
 * The lawyer: an Ollama tool-calling loop acting for one client (SPEC §9.2).
 *
 * - At most 10 tool calls per client turn.
 * - think:false everywhere except the call right after mock-trial results come back, where the
 *   lawyer picks a strategy (glm-5.3-flash is a thinking model; thinking is dropped, never shown).
 * - Everything is persisted in lawyer.db after each step, so a Sprite nap mid-turn resumes on boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadCast } from "../shared/cast.ts";
import type { Config } from "../shared/config.ts";
import type { Jev } from "../shared/jev.ts";
import type { ChatMessage, Ollama } from "../shared/ollama.ts";
import type { CourtClient } from "./court.ts";
import type { LawyerDB } from "./db.ts";
import { brierScore, caseList, recentLessons } from "./memory.ts";
import { runTool, TOOL_DEFS, type Filing, type MatterState, type Pending } from "./tools.ts";

export const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_MODEL_CALLS_PER_TURN = 16;

export const FIXED_RULES = `Rules you always follow:
1. You represent only your client. Be on their side, kindly.
2. You are truthful about facts. Never invent what happened; ask your client instead.
3. You never try to manipulate the court: no bribes, flattery, threats or orders. The court screens every filing for contempt.
4. You explain your strategy to your client in plain, friendly words a kid understands.
5. You must run a mock_trial before filing.
6. You must get your client's explicit OK before filing: call ask_client with confirm_filing showing the exact filing, and only file after they press Yes.
   If the best mock-trial draft is under 50%, be honest that it's a long shot (your weak-case line is added to that question automatically).
Keep everything PG, short and fun.

How a case usually goes: interview your client (ask_client) until you know what happened and what they want; read_family_code; search_precedent; mock_trial with 2 or 3 different drafts; explain the results and your pick; ask_client with confirm_filing; file_case with exactly that filing; watch_hearing; then tell your client what happened and what you learned.`;

/**
 * Who can be a party, in the system prompt. Every case needs a defendant from this list: on
 * fc-court the lawyer once tried "Family Code" as the defendant for a plain question to the court.
 */
export function partiesSection(client: string, parties: { alias: string; role: string }[] | null): string {
  const rule =
    "Every case is against one of these people, written exactly as shown. Never your own client, and never the court, the judge or the Family Code. " +
    "If it isn't clear who the case is against, ask_client who it's about, listing these names, before any mock_trial. " +
    "A question for the court is a real case (a declaration) whenever the Family Code allows it, so check read_family_code rather than turning it down: ask your client who disagrees with them, and that person is the defendant.";
  if (!parties) return `Your client is ${client}. The court's party list didn't load: call list_parties before any mock_trial. ${rule}`;
  const others = parties.filter((p) => p.alias.toLowerCase() !== client.toLowerCase());
  return [`Your client is ${client}. People your client can bring a case against (alias, role):`, ...others.map((p) => `- ${p.alias} (${p.role})`), rule].join("\n");
}

export interface LawyerContext {
  cfg: Config;
  db: LawyerDB;
  jev: Jev;
  ollama: Ollama;
  court: CourtClient;
  /** "update" fires with a matter ref whenever something the UI shows changes. */
  bus: EventEmitter<{ update: [string] }>;
  log: (m: string) => void;
}

interface MatterRow {
  case_ref: string;
  messages_json: string;
  pending_json: string | null;
  confirmed_json: string | null;
  mock_calls: number;
  mock_json: string | null;
  running: number;
  closed: number;
}

export class Lawyer {
  private running = new Map<string, Promise<void>>();

  constructor(private readonly ctx: LawyerContext) {}

  get client(): string | undefined {
    return this.ctx.cfg.LAWYER_CLIENT;
  }

  // ---------- matters ----------

  currentMatter(): string {
    const row = this.ctx.db.prepare("SELECT case_ref FROM matters WHERE closed = 0 ORDER BY created_at DESC LIMIT 1").get() as { case_ref: string } | undefined;
    return row?.case_ref ?? this.newMatter();
  }

  newMatter(): string {
    const db = this.ctx.db;
    db.prepare("UPDATE matters SET closed = 1 WHERE closed = 0").run();
    const n = ((db.prepare("SELECT COUNT(*) AS n FROM matters").get() as { n: number }).n ?? 0) + 1;
    const ref = `M${n}`;
    const now = Date.now();
    db.prepare("INSERT INTO matters(case_ref, messages_json, created_at, updated_at) VALUES (?, '[]', ?, ?)").run(ref, now, now);
    this.ctx.bus.emit("update", ref);
    return ref;
  }

  private load(ref: string): MatterRow {
    const row = this.ctx.db.prepare("SELECT * FROM matters WHERE case_ref = ?").get(ref) as MatterRow | undefined;
    if (!row) throw new Error(`No matter ${ref}`);
    return row;
  }

  private stateOf(row: MatterRow): MatterState {
    const filed = this.ctx.db.prepare("SELECT court_case_number FROM cases WHERE case_ref = ?").get(row.case_ref) as { court_case_number: number } | undefined;
    return {
      ref: row.case_ref,
      mockCalls: row.mock_calls,
      mock: row.mock_json ? JSON.parse(row.mock_json) : null,
      confirmed: row.confirmed_json ? (JSON.parse(row.confirmed_json) as Filing) : null,
      filedNumber: filed?.court_case_number ?? null,
    };
  }

  private save(ref: string, messages: ChatMessage[], state: MatterState, pending: Pending | null, running: boolean) {
    this.ctx.db
      .prepare(
        "UPDATE matters SET messages_json = ?, pending_json = ?, confirmed_json = ?, mock_calls = ?, mock_json = ?, running = ?, updated_at = ? WHERE case_ref = ?",
      )
      .run(
        JSON.stringify(messages),
        pending ? JSON.stringify(pending) : null,
        state.confirmed ? JSON.stringify(state.confirmed) : null,
        state.mockCalls,
        state.mock ? JSON.stringify(state.mock) : null,
        running ? 1 : 0,
        Date.now(),
        ref,
      );
    this.ctx.bus.emit("update", ref);
  }

  private say(ref: string, role: "client" | "lawyer", content: string) {
    this.ctx.db.prepare("INSERT INTO conversations(case_ref, role, content, created_at) VALUES (?, ?, ?, ?)").run(ref, role, content, Date.now());
    this.ctx.bus.emit("update", ref);
  }

  private note(ref: string, tool: string, note: string, input?: unknown, output?: unknown) {
    this.ctx.db
      .prepare("INSERT INTO steps(case_ref, ts, tool, note, input_json, output_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ref, Date.now(), tool, note, input === undefined ? null : JSON.stringify(input), output === undefined ? null : JSON.stringify(output));
    this.ctx.bus.emit("update", ref);
  }

  // ---------- turns ----------

  isRunning(ref: string) {
    return this.running.has(ref);
  }

  /** The client spoke (text) or pressed Yes/No (confirm). Runs the turn in the background. */
  handle(ref: string, input: { text?: string; confirm?: boolean }): Promise<void> {
    if (this.running.has(ref)) return this.running.get(ref)!;
    const p = this.turn(ref, input)
      .catch((err) => {
        this.ctx.log(`[lawyer] turn failed: ${(err as Error).stack ?? err}`);
        this.say(ref, "lawyer", "Oops, I tripped over my briefcase. Could you say that again?");
        this.ctx.db.prepare("UPDATE matters SET running = 0 WHERE case_ref = ?").run(ref);
      })
      .finally(() => this.running.delete(ref));
    this.running.set(ref, p);
    return p;
  }

  /** On boot: finish any turn that was interrupted (the transcript says where it stopped). */
  resumeRunning(): string[] {
    const rows = this.ctx.db.prepare("SELECT case_ref FROM matters WHERE running = 1").all() as { case_ref: string }[];
    for (const r of rows) {
      const p = this.loop(r.case_ref)
        .catch((err) => this.ctx.log(`[lawyer] resume failed: ${(err as Error).message}`))
        .finally(() => this.running.delete(r.case_ref));
      this.running.set(r.case_ref, p);
    }
    return rows.map((r) => r.case_ref);
  }

  private async turn(ref: string, input: { text?: string; confirm?: boolean }) {
    const row = this.load(ref);
    const messages = JSON.parse(row.messages_json) as ChatMessage[];
    const state = this.stateOf(row);
    const pending = row.pending_json ? (JSON.parse(row.pending_json) as Pending) : null;
    const text = (input.text ?? "").trim().slice(0, 2000);

    if (pending) {
      let answer: string;
      if (pending.kind === "confirm_filing") {
        if (input.confirm === true) {
          state.confirmed = pending.filing!;
          this.say(ref, "client", "👍 Yes, file it!");
          answer = "The client pressed YES. You may now call file_case with exactly this filing.";
        } else if (input.confirm === false) {
          this.say(ref, "client", text ? `👎 Not yet. ${text}` : "👎 Not yet.");
          answer = `The client pressed NO. Do not file.${text ? ` They added: "${text}"` : ""}`;
        } else {
          this.say(ref, "client", text);
          answer = `The client did not press Yes. They wrote: "${text}". Do not file; answer them, and ask again later if it makes sense.`;
        }
      } else {
        const said = text || (input.confirm === true ? "Yes" : input.confirm === false ? "No" : "");
        this.say(ref, "client", said);
        answer = said;
      }
      messages.push({ role: "tool", tool_name: "ask_client", content: answer });
    } else {
      if (!text) return;
      this.say(ref, "client", text);
      messages.push({ role: "user", content: text });
    }
    this.save(ref, messages, state, null, true);
    await this.loop(ref);
  }

  private persona(): string {
    try {
      return readFileSync(join(this.ctx.cfg.CONTENT_DIR, "lawyer-persona.md"), "utf8");
    } catch {
      return "You are a friendly, clever lawyer for a kid in a family court.";
    }
  }

  private systemPrompt(parties: { alias: string; role: string }[] | null): string {
    const persona = this.persona();
    const lessons = recentLessons(this.ctx.db);
    return [
      persona.trim(),
      FIXED_RULES,
      partiesSection(this.client!, parties),
      lessons.length ? `Lessons from your past cases:\n${lessons.map((l) => `- ${l}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async loop(ref: string) {
    const row = this.load(ref);
    const messages = JSON.parse(row.messages_json) as ChatMessage[];
    const state = this.stateOf(row);
    // The court's party list, up front, so the lawyer picks real people instead of guessing.
    const parties = await this.ctx.court.parties().catch(() => this.ctx.court.parties().catch(() => null));
    const system: ChatMessage = { role: "system", content: this.systemPrompt(parties) };
    const deps = {
      db: this.ctx.db,
      jev: this.ctx.jev,
      ollama: this.ctx.ollama,
      court: this.ctx.court,
      client: this.client!,
      onNote: (n: string) => this.note(ref, "watch_hearing", n),
      persona: () => this.persona(),
    };

    let toolCalls = 0;
    let think = false;
    for (let modelCalls = 0; modelCalls < MAX_MODEL_CALLS_PER_TURN; modelCalls++) {
      const out = toolCalls >= MAX_TOOL_CALLS_PER_TURN;
      const res = await this.ctx.ollama.chat({ messages: [system, ...messages], tools: out ? undefined : TOOL_DEFS, think });
      think = false;

      if (res.tool_calls.length && !out) {
        messages.push({ role: "assistant", content: res.content, tool_calls: res.tool_calls });
        for (const tc of res.tool_calls) {
          const name = tc.function.name;
          if (toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
            messages.push({ role: "tool", tool_name: name, content: JSON.stringify({ error: "Tool limit for this turn reached. Reply to your client now." }) });
            continue;
          }
          toolCalls++;
          const args = (typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments) ?? {};
          const r = await runTool(name, args, state, deps);
          this.note(ref, name, r.note, args, r.result);
          if (r.pause) {
            // The client's answer becomes this tool call's result when they reply.
            this.say(ref, "lawyer", r.pause.question);
            this.save(ref, messages, state, r.pause, false);
            return;
          }
          messages.push({ role: "tool", tool_name: name, content: JSON.stringify(r.result) });
          if (name === "mock_trial" && r.ok) think = true; // strategy time
          this.save(ref, messages, state, null, true);
        }
        continue;
      }

      const reply = res.content.trim() || "Hmm, let me think about that. What else can you tell me?";
      messages.push({ role: "assistant", content: reply });
      this.say(ref, "lawyer", reply);
      this.save(ref, messages, state, null, false);
      return;
    }
    this.say(ref, "lawyer", "I've done a lot of homework on this. What would you like to do next?");
    this.save(ref, messages, state, null, false);
  }

  // ---------- what the UI shows ----------

  view(ref: string) {
    const row = this.load(ref);
    const db = this.ctx.db;
    const cases = caseList(db);
    const brier = brierScore(cases);
    return {
      client: this.client ?? null,
      lawyer: loadCast(this.ctx.cfg.CONTENT_DIR).lawyer,
      // Where case pages live (the court may be on another Sprite).
      courtUrl: /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(this.ctx.cfg.COURT_URL) ? "" : this.ctx.cfg.COURT_URL.replace(/\/+$/, ""),
      matter: ref,
      running: this.isRunning(ref) || row.running === 1,
      pending: row.pending_json ? (JSON.parse(row.pending_json) as Pending) : null,
      messages: db.prepare("SELECT role, content, created_at FROM conversations WHERE case_ref = ? ORDER BY id").all(ref) as { role: string; content: string; created_at: number }[],
      notes: db.prepare("SELECT tool, note, ts FROM steps WHERE case_ref = ? ORDER BY id DESC LIMIT 60").all(ref) as { tool: string; note: string; ts: number }[],
      mock: row.mock_json ? JSON.parse(row.mock_json) : null,
      cases: cases.map((c) => ({ ...c, predictedPct: c.predicted != null ? Math.round(c.predicted * 100) : null })),
      accuracy: brier == null ? null : { brier: Math.round(brier * 1000) / 1000, finished: cases.filter((c) => c.outcome).length },
      lessons: recentLessons(db, 5),
    };
  }
}
