/**
 * The hearing pipeline (SPEC §8.2). Every step appends to `events`, which the SSE stream replays.
 *
 * Steps are idempotent, keyed by which events already exist. Every Jev answer is stored on its
 * event and reused on resume: Jev drifts a few points between identical runs, so re-asking after
 * a Sprite wake could flip a verdict.
 */
import { randomBytes } from "node:crypto";
import { GatewayError } from "../shared/gateway.ts";
import { contemptLetter, rulingLetter, summonsLetter } from "./mail.ts";
import { RecessError } from "../shared/budget.ts";
import {
  band,
  buildState,
  caseTypeQuestion,
  contemptQuestion,
  CONTEMPT_SENTENCE_LEVEL,
  decide,
  deliberationQuestions,
  JUSTICE_KEYS,
  precedentRelevanceQuestion,
  RECUSAL,
  sufficiencyQuestion,
  THRESHOLDS,
  type CaseType,
  type ChoiceAnswer,
  type Decision,
  type JusticeKey,
  type Precedent,
  type ScoreAnswer,
  type Side,
} from "../shared/panel.ts";
import type { CourtContext } from "./context.ts";
import { FINAL_STATUSES, OPEN_STATUSES, type CaseRow, type CaseStatus, type EventRow, type FilingRow } from "./db.ts";
import type { FamilyCode } from "./familyCode.ts";
import { writeOpinion, type OpinionFacts } from "./opinion.ts";
import { landmarkAsPrecedent } from "./landmarks.ts";
import { caseLabel, findPrecedent } from "./precedent.ts";
import { recordName, renderRecord } from "./record.ts";
import { caseView } from "./views.ts";
import { labelsFor } from "./labels.ts";

export interface FileInput {
  plaintiff: string;
  defendant: string;
  title?: string;
  claim: string;
  relief: string;
  filedBy: "pro_se" | "lawyer";
  /** Extra filings at filing time, e.g. the defendant's side when both are at the table. */
  filings?: { author: string; kind: string; body: string }[];
}

export interface ScreeningData {
  caseType: CaseType;
  caseTypeProbabilities?: Record<string, number>;
  contempt: { filingId: number; author: string; p: number; band: string }[];
}

export interface SufficiencyData {
  p: number;
  band: string;
  /** The party the judge hasn't heard from (alias snapshot), if any. */
  unheard?: string | null;
  unheardId?: string | null;
  /** Phase 1 events only. */
  inAbsentia?: string | null;
}

export interface SummonsRow {
  id: number;
  case_id: number;
  person_id: string;
  token: string;
  status: "pending" | "answered" | "expired";
  sent_via: "email" | "in_person";
  created_at: number;
  answered_at: number | null;
}

export class SummonsError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface DeliberationData {
  model: string;
  answers: Record<string, unknown>;
  precedent: Precedent[];
  memoryRecusal?: string;
}

export interface PrecedentCheck {
  /** Keyword matches, each with Jev's P(relevant). */
  candidates: { ref: string; number?: number; title: string; p: number }[];
  /** Only candidates with P(relevant) >= 0.7 reach Justice Memory. */
  kept: Precedent[];
}

export interface RulingData {
  kind: "ruled" | "too_close" | "contempt";
  decision: Decision | null;
  winner: string | null;
  contemnor?: string;
  sentenceLevel: number | null;
  sentenceText: string | null;
  confidencePct: number | null;
}

type Actor = "clerk" | "bailiff" | "judge" | "court" | "executive";

export class ApprovalError extends Error {}

export const justiceName = (ctx: Pick<CourtContext, "cast">, key: JusticeKey) =>
  ({ justice_letter: ctx.cast.justices.letter, justice_heart: ctx.cast.justices.heart, justice_memory: ctx.cast.justices.memory })[key];

export class Hearings {
  private running = new Map<number, Promise<void>>();

  constructor(private readonly ctx: CourtContext) {}

  // ---------- data helpers ----------

  getCase(id: number): CaseRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
  }

  getCaseByNumber(n: number): CaseRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM cases WHERE number = ?").get(n) as CaseRow | undefined;
  }

  private setStatus(id: number, status: CaseStatus) {
    this.ctx.db.prepare("UPDATE cases SET status = ? WHERE id = ?").run(status, id);
  }

  private filings(caseId: number, includeStruck = false): FilingRow[] {
    return this.ctx.db
      .prepare(`SELECT * FROM filings WHERE case_id = ? ${includeStruck ? "" : "AND struck = 0"} ORDER BY id`)
      .all(caseId) as FilingRow[];
  }

  private lastEvent(caseId: number, kind?: string): EventRow | undefined {
    return (
      kind
        ? this.ctx.db.prepare("SELECT * FROM events WHERE case_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(caseId, kind)
        : this.ctx.db.prepare("SELECT * FROM events WHERE case_id = ? ORDER BY id DESC LIMIT 1").get(caseId)
    ) as EventRow | undefined;
  }

  private data<T>(caseId: number, kind: string): T | undefined {
    const e = this.lastEvent(caseId, kind);
    return e?.data_json ? (JSON.parse(e.data_json) as T) : e ? ({} as T) : undefined;
  }

  emit(caseId: number, actor: Actor, kind: string, message: string, data?: unknown): EventRow {
    const ts = Date.now();
    const data_json = data === undefined ? null : JSON.stringify(data);
    const res = this.ctx.db
      .prepare("INSERT INTO events(case_id, ts, actor, kind, message, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(caseId, ts, actor, kind, message, data_json);
    const row: EventRow = { id: Number(res.lastInsertRowid), case_id: caseId, ts, actor, kind, message, data_json };
    this.ctx.bus.emit("event", row);
    return row;
  }

  // ---------- filing ----------

  private personId(alias: string): string | null {
    return this.ctx.people.find((p) => p.alias.toLowerCase() === alias.trim().toLowerCase())?.id ?? null;
  }

  file(input: FileInput): { id: number; number: number } {
    const db = this.ctx.db;
    const now = Date.now();
    const tx = db.transaction(() => {
      const { n } = db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM cases").get() as { n: number };
      const title = input.title?.trim() || `${input.plaintiff} v. ${input.defendant}`;
      const res = db
        .prepare(
          `INSERT INTO cases(number, title, plaintiff, defendant, plaintiff_id, defendant_id, type, filed_by, claim, relief, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'filed', ?)`,
        )
        .run(n, title, input.plaintiff, input.defendant, this.personId(input.plaintiff), this.personId(input.defendant), input.filedBy, input.claim, input.relief, now);
      const id = Number(res.lastInsertRowid);
      const add = db.prepare("INSERT INTO filings(case_id, author, author_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      add.run(id, input.plaintiff, this.personId(input.plaintiff), "complaint", input.claim, now);
      for (const f of input.filings ?? []) add.run(id, f.author, this.personId(f.author), f.kind, f.body, now);
      return { id, number: n, title };
    });
    const { id, number, title } = tx();
    this.emit(id, "clerk", "case.filed", `${caseLabel(number)} is on the docket: ${title}.`);
    return { id, number };
  }

  // ---------- petitions ----------

  /** The Executive Branch (a parent) approves or denies a granted petition. */
  async decidePetition(caseId: number, decision: "approve" | "deny"): Promise<void> {
    const c = this.getCase(caseId);
    if (!c || c.approval !== "pending") throw new ApprovalError("This case isn't waiting for a parent's OK.");
    const approval = decision === "approve" ? "approved" : "denied";
    this.ctx.db.prepare("UPDATE cases SET approval = ? WHERE id = ? AND approval = 'pending'").run(approval, caseId);
    this.emit(
      caseId,
      "executive",
      `petition.${approval}`,
      approval === "approved"
        ? "The Executive Branch approves the petition. It's official!"
        : "The Executive Branch says no to this one. The court's ruling stands, but the house rule stays the same.",
      { approval },
    );
    await this.syncRecord(caseId);
  }

  // ---------- the spoken verdict (ElevenLabs) ----------

  private async recordVoice(caseId: number) {
    const c = this.getCase(caseId)!;
    const r = this.ctx.db.prepare("SELECT bench_verdict FROM rulings WHERE case_id = ? ORDER BY round DESC LIMIT 1").get(caseId) as
      | { bench_verdict: string | null }
      | undefined;
    if (!r?.bench_verdict) return;
    const result = await this.ctx.voice.speak(c.number, r.bench_verdict);
    if (result.status === "ready") {
      this.ctx.db.prepare("UPDATE rulings SET audio_path = ? WHERE case_id = ?").run(result.path, caseId);
      this.emit(caseId, "judge", "voice.ready", "The judge clears their throat…");
    } else if (result.status === "no_budget") {
      this.emit(caseId, "judge", "voice.unavailable", "The judge has lost their voice for today, so the verdict is in writing.", { reason: "no_budget" });
    } else if (result.status === "failed") {
      this.emit(caseId, "judge", "voice.unavailable", "The judge's microphone isn't working right now, so the verdict is in writing.", { reason: "failed" });
    }
  }

  // ---------- notices (AgentMail) ----------

  private async sendNotices(caseId: number, ruling: RulingData) {
    const c = this.getCase(caseId)!;
    const L = labelsFor(this.ctx.people, c);
    const url = `${this.ctx.cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/cases/${c.number}`;
    const label = caseLabel(c.number);
    const title = L.relabel(c.title);
    const headline =
      ruling.kind === "too_close"
        ? "It was too close to call, so the court ordered a compromise."
        : ruling.kind === "contempt"
          ? `${L.relabel(ruling.contemnor ?? "")} was held in contempt of court.`
          : `The court ruled for ${L.relabel(ruling.winner ?? "")}${ruling.decision?.vote ? ` (${ruling.decision.vote})` : ""}.${ruling.sentenceText ? ` Sentence: ${ruling.sentenceText}.` : ""}`;
    const sent: string[] = [];
    for (const pid of [...new Set([c.plaintiff_id, c.defendant_id].filter(Boolean) as string[])]) {
      const person = this.ctx.people.find((p) => p.id === pid);
      if (!person?.email) continue;
      const contemnorId = ruling.kind === "contempt" ? (pid === c.plaintiff_id && ruling.contemnor === c.plaintiff) || (pid === c.defendant_id && ruling.contemnor === c.defendant) : false;
      const l = contemnorId
        ? contemptLetter({ court: this.ctx.cast.court, alias: person.alias, caseLabel: label, title, sentence: ruling.sentenceText ?? "", url })
        : rulingLetter({ court: this.ctx.cast.court, alias: person.alias, caseLabel: label, title, headline, url });
      if ((await this.ctx.mailer.send(person, l)) === "sent") sent.push(person.alias);
    }
    if (sent.length) this.emit(caseId, "clerk", "notices.sent", `The clerk emails notice of the ruling to ${sent.join(" and ")}.`, { sent });
  }

  // ---------- the record (Box) ----------

  /** File (or re-file, as a new version) the case record in Box. Never throws. */
  async syncRecord(caseId: number): Promise<void> {
    const folder = this.ctx.cfg.BOX_RECORDS_FOLDER_ID;
    const c = this.getCase(caseId);
    if (!folder || !c) return;
    const r = this.ctx.db.prepare("SELECT box_file_id FROM rulings WHERE case_id = ? ORDER BY round DESC LIMIT 1").get(caseId) as
      | { box_file_id: string | null }
      | undefined;
    if (!r) return;
    const name = recordName(c.number);
    const md = renderRecord(caseView(c, this.ctx), this.ctx.cast.court);
    try {
      const info = r.box_file_id ? await this.ctx.box.uploadVersion(r.box_file_id, name, md) : await this.ctx.box.upsertText(folder, name, md);
      this.ctx.db.prepare("UPDATE rulings SET box_file_id = ? WHERE case_id = ?").run(info.id, caseId);
      const first = !this.lastEvent(caseId, "record.filed");
      this.emit(
        caseId,
        "clerk",
        first ? "record.filed" : "record.updated",
        first ? `The clerk files the official record in Box (${name}).` : `The clerk updates the official record in Box (${name}).`,
        { boxFileId: info.id, versionId: info.versionId },
      );
    } catch (err) {
      this.ctx.log(`[record] ${name}: ${(err as Error).message}`);
      if (this.lastEvent(caseId)?.kind !== "record.trouble") {
        this.emit(caseId, "clerk", "record.trouble", "The clerk couldn't reach the Box filing cabinet. The record will be filed later.");
      }
    }
  }

  /** On boot: file any closed case whose record never made it to Box. */
  async retryRecords(): Promise<number> {
    if (!this.ctx.cfg.BOX_RECORDS_FOLDER_ID) return 0;
    const rows = this.ctx.db
      .prepare(
        `SELECT c.id FROM cases c JOIN rulings r ON r.case_id = c.id
          WHERE c.status IN ('ruled','too_close','contempt')
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.case_id = c.id AND e.kind = 'record.filed')
          ORDER BY c.id LIMIT 20`,
      )
      .all() as { id: number }[];
    for (const row of rows) await this.syncRecord(row.id);
    return rows.length;
  }

  // ---------- running ----------

  /** Start (or join) the hearing for a case. Never rejects. */
  start(caseId: number): Promise<void> {
    const existing = this.running.get(caseId);
    if (existing) return existing;
    const p = this.run(caseId)
      .catch((err) => this.onError(caseId, err))
      .finally(() => this.running.delete(caseId));
    this.running.set(caseId, p);
    return p;
  }

  isRunning(caseId: number) {
    return this.running.has(caseId);
  }

  /** On startup: continue any hearing that was interrupted. */
  resumeOpen(): number[] {
    const rows = this.ctx.db
      .prepare(`SELECT id FROM cases WHERE status IN (${[...OPEN_STATUSES].map(() => "?").join(",")}) ORDER BY id`)
      .all(...OPEN_STATUSES) as { id: number }[];
    for (const r of rows) void this.start(r.id);
    return rows.map((r) => r.id);
  }

  private onError(caseId: number, err: unknown) {
    const last = this.lastEvent(caseId);
    if (err instanceof RecessError) {
      if (last?.kind !== "court.recess") {
        this.emit(caseId, "court", "court.recess", "Court is in recess until tomorrow. This case will pick up right where it left off.");
      }
      return;
    }
    this.ctx.log(`[hearing] case ${caseId} hit a snag: ${err instanceof GatewayError ? err.message : (err as Error)?.stack ?? err}`);
    if (last?.kind !== "court.trouble") {
      this.emit(caseId, "court", "court.trouble", "The court hit a snag reaching the judge. It will try again when someone opens this case.");
    }
  }

  private async run(caseId: number): Promise<void> {
    const ctx = this.ctx;
    let c = this.getCase(caseId);
    if (!c || FINAL_STATUSES.has(c.status)) return;
    const label = caseLabel(c.number);

    // 1. All rise
    if (!this.lastEvent(caseId, "court.opened")) {
      this.emit(caseId, "clerk", "court.opened", `All rise! ${label}, ${c.title}. ${/^the\b/i.test(ctx.cast.judge) ? ctx.cast.judge : `The Honorable ${ctx.cast.judge}`} presiding.`);
    }

    // 2. Screening: contempt for each new filing, plus the case type on the first round
    if (c.status === "filed") this.setStatus(caseId, "screening");
    let screening = this.data<ScreeningData>(caseId, "screening.done");
    if (!screening) screening = await this.screen(c);
    c = this.getCase(caseId)!;
    const caseType = (c.type as CaseType) ?? screening.caseType;

    // 3. Law library (checks Box for a newer version; falls back politely)
    const code = await ctx.familyCode.refresh();
    if (!this.lastEvent(caseId, "law.loaded")) {
      this.emit(
        caseId,
        "clerk",
        "law.loaded",
        `The clerk opens the Family Code: ${code.articles.length} article${code.articles.length === 1 ? "" : "s"}.`,
        { articles: code.articles.length, warnings: code.warnings },
      );
    }

    const struck = this.filings(caseId, true).filter((f) => f.struck);
    if (struck.length) return this.finish(c, code, await this.contemptRuling(c, code, struck[0]));

    // 4. Sufficiency: summon the unheard party once, and wait (or proceed in absentia)
    if (c.status !== "awaiting_testimony") this.setStatus(caseId, "gathering");
    let sufficiency = this.data<SufficiencyData>(caseId, "sufficiency.done");
    if (!sufficiency) sufficiency = await this.checkSufficiency(c, code);
    const gate = await this.gatherTestimony(c, sufficiency);
    if (gate.pause) return;
    this.setStatus(caseId, "gathering");

    // Testimony gets its own contempt screen.
    if (this.filings(caseId, true).some((f) => f.contempt_noul === null)) await this.screenMore(c);
    const struckLater = this.filings(caseId, true).filter((f) => f.struck);
    if (struckLater.length) return this.finish(c, code, await this.contemptRuling(c, code, struckLater[0]));

    // 5. Deliberation
    this.setStatus(caseId, "deliberating");
    let delib = this.data<DeliberationData>(caseId, "deliberation.done");
    if (!delib) delib = await this.deliberate(c, caseType, code);

    // 6. Ruling
    let ruling = this.data<RulingData>(caseId, "ruling.decided");
    if (!ruling) ruling = this.rule(c, caseType, code, delib);

    return this.finish(c, code, ruling, gate.inAbsentia);
  }

  private computedFacts(c: CaseRow) {
    const filings = this.filings(c.id);
    const heard = [...new Set(filings.map((f) => f.author))];
    return {
      filings_count: filings.length,
      parties_heard: heard,
      plaintiff_heard: heard.includes(c.plaintiff),
      defendant_heard: heard.includes(c.defendant),
    };
  }

  private async screen(c: CaseRow): Promise<ScreeningData> {
    const pending = this.filings(c.id, true).filter((f) => f.contempt_noul === null);
    const questions: Record<string, any> = {};
    for (const f of pending) questions[`contempt_F${f.id}`] = contemptQuestion(`F${f.id}`);
    if (!c.type) questions.case_type = caseTypeQuestion();

    const state = buildState({
      case: c,
      filings: pending.map((f) => ({ ref: `F${f.id}`, author: f.author, kind: f.kind, body: f.body })),
    });
    const res = await this.ctx.jev.ask(state, questions);
    const a = res.answers as Record<string, any>;

    const caseType: CaseType = (a.case_type?.choice as CaseType) ?? (c.type as CaseType) ?? "complaint";
    const contempt = pending.map((f) => {
      const p = Number(a[`contempt_F${f.id}`]?.noul ?? 0);
      return { filingId: f.id, author: f.author, p, band: band(p) };
    });
    const data: ScreeningData = { caseType, caseTypeProbabilities: a.case_type?.probabilities, contempt };

    const db = this.ctx.db;
    db.transaction(() => {
      const upd = db.prepare("UPDATE filings SET contempt_noul = ?, struck = ? WHERE id = ?");
      for (const x of contempt) upd.run(x.p, x.p >= THRESHOLDS.yes ? 1 : 0, x.filingId);
      db.prepare("UPDATE cases SET type = ? WHERE id = ? AND type IS NULL").run(caseType, c.id);
    })();

    this.emit(c.id, "bailiff", "screening.done", `The bailiff checks the filings for funny business. The clerk marks this as a ${caseType}.`, data);
    for (const x of contempt) {
      if (x.band === "unsure") this.emit(c.id, "bailiff", "contempt.warning", `The court has its eye on you, ${x.author}.`, x);
      if (x.band === "yes") this.emit(c.id, "bailiff", "contempt.found", `Objection! ${x.author}'s filing tries to sway the court. It is struck from the record.`, x);
    }
    return data;
  }

  private async checkSufficiency(c: CaseRow, code: FamilyCode): Promise<SufficiencyData> {
    const facts = this.computedFacts(c);
    const state = buildState({
      case: c,
      filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
      familyCode: code.text,
      computedFacts: facts,
    });
    const res = await this.ctx.jev.ask(state, { sufficient: sufficiencyQuestion() });
    const p = res.answers.sufficient.noul;
    const unheard = !facts.defendant_heard ? c.defendant : !facts.plaintiff_heard ? c.plaintiff : null;
    const unheardId = unheard === c.defendant ? c.defendant_id : unheard === c.plaintiff ? c.plaintiff_id : null;
    const data: SufficiencyData = { p, band: band(p), unheard, unheardId };
    const msg =
      p >= THRESHOLDS.yes
        ? "The judge has heard enough to decide."
        : unheard
          ? `The judge would like to hear from ${unheard} before deciding.`
          : "The record is a little thin, but the court will decide anyway.";
    this.emit(c.id, "judge", "sufficiency.done", msg, data);
    return data;
  }

  /**
   * Keyword search finds candidate past rulings; one batched Jev request then asks, for each,
   * whether it's relevant. Only P >= 0.7 survives. Stored on the event, like every Jev answer.
   */
  private async checkPrecedent(c: CaseRow): Promise<PrecedentCheck> {
    const existing = this.data<PrecedentCheck>(c.id, "precedent.checked");
    if (existing) return existing;
    const keywordMatches = findPrecedent(this.ctx.db, `${c.title} ${c.claim} ${c.relief}`, {
      excludeCaseId: c.id,
      ignore: [c.plaintiff, c.defendant, ...this.ctx.people.map((p) => p.alias)],
    });
    // Landmarks are few, so every one goes to the relevance check alongside the keyword matches.
    const candidates = [...this.ctx.landmarks.load().landmarks.map(landmarkAsPrecedent), ...keywordMatches];
    let check: PrecedentCheck = { candidates: [], kept: [] };
    if (candidates.length) {
      const questions: Record<string, ReturnType<typeof precedentRelevanceQuestion>> = {};
      for (const p of candidates) questions[`relevant_${p.ref}`] = precedentRelevanceQuestion(p.ref!);
      const state = {
        current_dispute: buildState({
          case: c,
          filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
        }),
        past_rulings: candidates,
      };
      const res = await this.ctx.jev.ask(state, questions);
      const answers = res.answers as Record<string, { noul: number }>;
      const scored = candidates.map((p) => ({ p, relevance: Number(answers[`relevant_${p.ref}`]?.noul ?? 0) }));
      check = {
        candidates: scored.map(({ p, relevance }) => ({ ref: p.ref!, number: p.number, title: p.title ?? "", p: relevance })),
        // Most relevant first; the state carries at most 8 precedents.
        kept: scored
          .filter((x) => x.relevance >= THRESHOLDS.yes)
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, 8)
          .map((x) => x.p),
      };
    }
    const n = check.candidates.length;
    const k = check.kept.length;
    const msg = !n
      ? "The clerk searches the records: no past cases like this one yet."
      : `The clerk pulls ${n} past case${n === 1 ? "" : "s"}; ${k ? `${k} ${k === 1 ? "is" : "are"} relevant` : "none of them are really about this"}.`;
    this.emit(c.id, "clerk", "precedent.checked", msg, check);
    return check;
  }

  // ---------- summons (SPEC §8.6) ----------

  summonsFor(caseId: number): SummonsRow[] {
    return this.ctx.db.prepare("SELECT * FROM summons WHERE case_id = ? ORDER BY id").all(caseId) as SummonsRow[];
  }

  private timeoutMs() {
    return this.ctx.cfg.SUMMONS_TIMEOUT_MIN * 60_000;
  }

  /**
   * Decide whether to wait for testimony. Each party is summoned at most once per case; after
   * testimony arrives, or the summons times out, the court deliberates regardless.
   */
  private async gatherTestimony(c: CaseRow, s: SufficiencyData): Promise<{ pause: true } | { pause: false; inAbsentia: string | null }> {
    const unheard = s.unheard ?? s.inAbsentia ?? null;
    if (s.p >= THRESHOLDS.yes || !unheard) return { pause: false, inAbsentia: null };
    const personId = s.unheardId ?? null;
    if (!personId) return { pause: false, inAbsentia: unheard }; // not on the court's list: can't be summoned
    const existing = this.summonsFor(c.id).find((x) => x.person_id === personId);
    if (!existing) {
      await this.issueSummons(c, personId, unheard);
      return { pause: true };
    }
    if (existing.status === "answered") return { pause: false, inAbsentia: null };
    if (existing.status === "expired") return { pause: false, inAbsentia: unheard };
    const due = existing.created_at + this.timeoutMs();
    if (Date.now() >= due) {
      this.ctx.db.prepare("UPDATE summons SET status = 'expired' WHERE id = ? AND status = 'pending'").run(existing.id);
      this.emit(c.id, "clerk", "summons.expired", `${unheard} didn't answer the summons in time, so the court will decide without them (in absentia).`);
      return { pause: false, inAbsentia: unheard };
    }
    this.setStatus(c.id, "awaiting_testimony");
    this.wakeAt(c.id, due);
    return { pause: true };
  }

  private wakeTimers = new Map<number, NodeJS.Timeout>();
  private wakeAt(caseId: number, when: number) {
    if (this.wakeTimers.has(caseId)) return;
    const t = setTimeout(() => {
      this.wakeTimers.delete(caseId);
      void this.start(caseId);
    }, Math.max(0, when - Date.now()) + 250);
    t.unref();
    this.wakeTimers.set(caseId, t);
  }

  private async issueSummons(c: CaseRow, personId: string, alias: string) {
    const token = randomBytes(32).toString("base64url");
    const person = this.ctx.people.find((p) => p.id === personId);
    const url = `${this.ctx.cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/summons/${token}`;
    const other = alias === c.plaintiff ? c.defendant : c.plaintiff;
    const result = await this.ctx.mailer.send(
      person,
      summonsLetter({ court: this.ctx.cast.court, alias: person?.alias ?? alias, caseLabel: caseLabel(c.number), title: c.title, otherParty: other, url, minutes: this.ctx.cfg.SUMMONS_TIMEOUT_MIN }),
    );
    const via = result === "sent" ? "email" : "in_person";
    this.ctx.db
      .prepare("INSERT INTO summons(case_id, person_id, token, status, sent_via, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(c.id, personId, token, via, Date.now());
    this.setStatus(c.id, "awaiting_testimony");
    const how =
      via === "email"
        ? "A summons is on its way by email."
        : result === "budget"
          ? "The court is out of stamps for today, so please answer here in person."
          : "Please answer here in person: tap “Tell your side”.";
    this.emit(c.id, "clerk", "summons.issued", `The court summons ${alias} to tell their side. ${how}`, { party: alias, via });
    this.wakeAt(c.id, Date.now() + this.timeoutMs());
  }

  /** Testimony from a summons link. Resumes the hearing. */
  answerSummons(token: string, testimony: string): { caseNumber: number } {
    const s = this.ctx.db.prepare("SELECT * FROM summons WHERE token = ?").get(token) as SummonsRow | undefined;
    if (!s) throw new SummonsError(404, "The court can't find that summons.");
    if (s.status !== "pending") {
      throw new SummonsError(409, s.status === "answered" ? "The court already heard from you. Thank you!" : "This summons has expired, and the court decided without you.");
    }
    const c = this.getCase(s.case_id)!;
    const alias = s.person_id === c.plaintiff_id ? c.plaintiff : s.person_id === c.defendant_id ? c.defendant : this.ctx.people.find((p) => p.id === s.person_id)?.alias ?? "Witness";
    const now = Date.now();
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare("UPDATE summons SET status = 'answered', answered_at = ? WHERE id = ?").run(now, s.id);
      this.ctx.db
        .prepare("INSERT INTO filings(case_id, author, author_id, kind, body, created_at) VALUES (?, ?, ?, 'testimony', ?, ?)")
        .run(c.id, alias, s.person_id, testimony, now);
    })();
    clearTimeout(this.wakeTimers.get(c.id));
    this.wakeTimers.delete(c.id);
    this.emit(c.id, "clerk", "testimony.received", `${alias} has answered the summons. The hearing continues!`);
    void this.start(c.id);
    return { caseNumber: c.number };
  }

  summonsByToken(token: string): SummonsRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM summons WHERE token = ?").get(token) as SummonsRow | undefined;
  }

  /** Contempt screen for filings added after the first screening (testimony). */
  private async screenMore(c: CaseRow) {
    const pending = this.filings(c.id, true).filter((f) => f.contempt_noul === null);
    const questions: Record<string, ReturnType<typeof contemptQuestion>> = {};
    for (const f of pending) questions[`contempt_F${f.id}`] = contemptQuestion(`F${f.id}`);
    const state = buildState({ case: c, filings: pending.map((f) => ({ ref: `F${f.id}`, author: f.author, kind: f.kind, body: f.body })) });
    const res = await this.ctx.jev.ask(state, questions);
    const a = res.answers as Record<string, { noul: number }>;
    const results = pending.map((f) => {
      const p = Number(a[`contempt_F${f.id}`]?.noul ?? 0);
      return { filingId: f.id, author: f.author, p, band: band(p) };
    });
    const upd = this.ctx.db.prepare("UPDATE filings SET contempt_noul = ?, struck = ? WHERE id = ?");
    this.ctx.db.transaction(() => results.forEach((x) => upd.run(x.p, x.p >= THRESHOLDS.yes ? 1 : 0, x.filingId)))();
    this.emit(c.id, "bailiff", "screening.more", "The bailiff checks the new testimony for funny business.", { contempt: results });
    for (const x of results) {
      if (x.band === "unsure") this.emit(c.id, "bailiff", "contempt.warning", `The court has its eye on you, ${x.author}.`, x);
      if (x.band === "yes") this.emit(c.id, "bailiff", "contempt.found", `Objection! ${x.author}'s testimony tries to sway the court. It is struck from the record.`, x);
    }
  }

  private async deliberate(c: CaseRow, caseType: CaseType, code: FamilyCode): Promise<DeliberationData> {
    const check = await this.checkPrecedent(c);
    const precedent = check.kept;
    const memoryRecusal = precedent.length ? undefined : check.candidates.length ? RECUSAL.noRelevantPrecedent : RECUSAL.noPrecedent;
    const questions = deliberationQuestions({
      case: c,
      caseType,
      hasPrecedent: precedent.length > 0,
      sentencingLevels: code.sentencing,
    });
    const state = buildState({
      case: { ...c, type: caseType },
      filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
      familyCode: code.text,
      precedent,
      computedFacts: this.computedFacts(c),
    });
    this.emit(c.id, "judge", "deliberation.started", "The justices put their heads together…");
    const res = await this.ctx.jev.ask(state, questions);
    const data: DeliberationData = { model: res.model, answers: res.answers as Record<string, unknown>, precedent, memoryRecusal };
    const n = precedent.length;
    this.emit(
      c.id,
      "judge",
      "deliberation.done",
      n ? `The justices have voted, with ${n} past case${n === 1 ? "" : "s"} in mind.` : "The justices have voted. (No relevant past cases to go on.)",
      data,
    );
    return data;
  }

  private rule(c: CaseRow, caseType: CaseType, code: FamilyCode, delib: DeliberationData): RulingData {
    const answers = delib.answers as Record<string, any>;
    const justices: Partial<Record<JusticeKey, ChoiceAnswer>> = {};
    for (const k of JUSTICE_KEYS) if (answers[k]) justices[k] = answers[k];
    const decision = decide({
      caseType,
      justices,
      sentence: answers.sentence as ScoreAnswer | undefined,
      maxSentenceLevel: code.sentencing.length - 1,
      memoryRecusal: delib.memoryRecusal,
    });
    for (const seat of decision.seats) {
      if (seat.key === "justice_memory" && seat.status === "voted") seat.cites = delib.precedent.map((p) => p.ref ?? `P${p.number}`);
    }
    const winner = decision.outcome ? (decision.outcome === "plaintiff" ? c.plaintiff : c.defendant) : null;
    const sentenceText = decision.sentenceLevel !== null ? code.sentencing[decision.sentenceLevel] : null;
    const confidencePct = Math.round(decision.caseConfidence * 100);
    const data: RulingData = {
      kind: decision.status,
      decision,
      winner,
      sentenceLevel: decision.sentenceLevel,
      sentenceText,
      confidencePct,
    };
    this.saveRuling(c, data);

    let msg: string;
    if (decision.status === "ruled") {
      const recused = decision.seats.some((s) => s.status === "recused");
      msg = `The panel rules ${decision.vote}${recused ? " (one justice recused)" : ""} for ${winner}. The court is ${confidencePct}% sure.`;
      if (caseType === "petition" && decision.outcome === "plaintiff") msg += " Recommended to the Executive Branch (a parent) for approval.";
      if (sentenceText) msg += ` Sentence: ${sentenceText}.`;
    } else {
      const lean = decision.lean ? `leaning ${decision.lean === "plaintiff" ? c.plaintiff : c.defendant} ${decision.vote}` : `split ${decision.vote}`;
      msg = `Too close to call (${lean}, only ${confidencePct}% sure). The court will order a compromise.`;
    }
    this.emit(c.id, "judge", "ruling.decided", msg, data);
    return data;
  }

  private async contemptRuling(c: CaseRow, code: FamilyCode, filing: FilingRow): Promise<RulingData> {
    const existing = this.data<RulingData>(c.id, "ruling.decided");
    if (existing) return existing;
    const level = Math.min(CONTEMPT_SENTENCE_LEVEL, code.sentencing.length - 1);
    const data: RulingData = {
      kind: "contempt",
      decision: null,
      winner: null,
      contemnor: filing.author,
      sentenceLevel: level,
      sentenceText: code.sentencing[level],
      confidencePct: filing.contempt_noul !== null ? Math.round(filing.contempt_noul * 100) : null,
    };
    this.saveRuling(c, data);
    this.emit(c.id, "judge", "ruling.decided", `${filing.author} is held in contempt of court! Sentence: ${data.sentenceText}.`, data);
    return data;
  }

  private saveRuling(c: CaseRow, r: RulingData) {
    const d = r.decision;
    const outcome = r.kind === "contempt" ? "contempt" : d?.outcome ?? "compromise";
    const panel = d ? d.seats.map((s) => ({ ...s, name: justiceName(this.ctx, s.key) })) : null;
    this.ctx.db
      .prepare(
        `INSERT INTO rulings(case_id, round, panel_json, outcome, vote, case_confidence, sentence_level, sentence_text, created_at)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(case_id, round) DO NOTHING`,
      )
      .run(c.id, panel ? JSON.stringify(panel) : null, outcome, d?.vote ?? null, d?.caseConfidence ?? null, r.sentenceLevel, r.sentenceText, Date.now());
  }

  // Steps 7–9: opinion, record, gavel
  private async finish(c: CaseRow, code: FamilyCode, ruling: RulingData, inAbsentia?: string | null): Promise<void> {
    const id = c.id;
    if (!this.lastEvent(id, "opinion.written")) {
      const facts = this.opinionFacts(c, code, ruling, inAbsentia ?? null);
      const op = await writeOpinion(this.ctx.ollama, this.ctx.persona(), facts, this.ctx.log);
      this.ctx.db
        .prepare("UPDATE rulings SET opinion_md = ?, bench_verdict = ?, cited_articles_json = ? WHERE case_id = ? AND round = 0")
        .run(op.opinion_md, op.bench_verdict, JSON.stringify(op.cited_articles), id);
      this.emit(id, "clerk", "opinion.written", "The clerk reads the court's opinion.", op);
    }

    const final: CaseStatus = ruling.kind === "contempt" ? "contempt" : ruling.kind === "too_close" ? "too_close" : "ruled";
    this.ctx.db.prepare("UPDATE cases SET status = ?, ruled_at = ? WHERE id = ?").run(final, Date.now(), id);
    // A granted petition is only a recommendation until a parent approves it.
    const granted = ruling.kind === "ruled" && ruling.decision?.outcome === "plaintiff" && this.getCase(id)!.type === "petition";
    if (granted) this.ctx.db.prepare("UPDATE cases SET approval = 'pending' WHERE id = ? AND approval IS NULL").run(id);

    // 8. Record: file it in Box (never blocks the gavel; retried on the next boot), then notices.
    if (!this.lastEvent(id, "record.filed")) await this.syncRecord(id);
    if (!this.lastEvent(id, "notices.sent")) await this.sendNotices(id, ruling);
    if (!this.lastEvent(id, "voice.ready") && !this.lastEvent(id, "voice.unavailable")) await this.recordVoice(id);

    // 9. Gavel
    if (!this.lastEvent(id, "case.closed")) {
      this.emit(id, "bailiff", "case.closed", "BANG! Court is adjourned.", { status: final });
    }
  }

  private opinionFacts(c: CaseRow, code: FamilyCode, r: RulingData, inAbsentia: string | null): OpinionFacts {
    const d = r.decision;
    const sideName = (s: Side) => (s === "plaintiff" ? c.plaintiff : c.defendant);
    const justices =
      d?.seats.map((s) => ({
        name: justiceName(this.ctx, s.key),
        vote: s.status === "voted" ? `${sideName(s.choice)} (${Math.round(s.probabilities[s.choice] * 100)}%)` : s.reason,
      })) ?? [];
    const dissent =
      d?.status === "ruled" && d.lean ? d.seats.find((s) => s.status === "voted" && s.choice !== d.lean) : undefined;
    return {
      kind: r.kind,
      caseNumber: c.number,
      title: c.title,
      caseType: c.type ?? "complaint",
      plaintiff: c.plaintiff,
      defendant: c.defendant,
      claim: c.claim,
      relief: c.relief,
      winner: r.winner ?? undefined,
      loser: r.winner ? (r.winner === c.plaintiff ? c.defendant : c.plaintiff) : undefined,
      lean: d?.lean ? sideName(d.lean) : undefined,
      contemnor: r.contemnor,
      vote: d?.vote,
      confidencePct: r.confidencePct ?? undefined,
      justices,
      dissenter: dissent ? justiceName(this.ctx, dissent.key) : undefined,
      sentence: r.sentenceLevel !== null && r.sentenceText ? { level: r.sentenceLevel, text: r.sentenceText } : undefined,
      inAbsentia: inAbsentia ?? undefined,
      articles: code.articles.map((a) => ({ number: a.number, title: a.title })),
      filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
    };
  }
}
