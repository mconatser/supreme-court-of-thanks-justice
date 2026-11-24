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
import { spokenVerdict } from "./voice.ts";
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
  ARTICLE_RELEVANCE,
  articleRelevanceQuestion,
  keepRelevant,
  newEvidenceQuestion,
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
import { CHECKPOINT_ID, MistrialError, VACATED_MARKER, vacatedBanner } from "./mistrial.ts";
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

type Actor = "clerk" | "bailiff" | "judge" | "court" | "executive" | "counsel";

export class ApprovalError extends Error {}

/**
 * A petition changes a house rule, so the court can only recommend it: a granted petition, and a
 * compromise on a petition (too close to call), both wait for a parent's OK.
 */
export function needsParentOk(r: Pick<RulingData, "kind" | "decision">, caseType: string | null): boolean {
  if (caseType !== "petition") return false;
  return (r.kind === "ruled" && r.decision?.outcome === "plaintiff") || r.kind === "too_close";
}
export class AppealError extends Error {}
export class RemarkError extends Error {}
export const MAX_REMARKS = 2;
export const MAX_REMARK_CHARS = 140;

/** An appeal is heard only if it adds something new (SPEC §8.7). */
export const APPEAL_NEW_EVIDENCE = 0.5;

export const justiceName = (ctx: Pick<CourtContext, "cast">, key: JusticeKey) =>
  ({ justice_letter: ctx.cast.justices.letter, justice_heart: ctx.cast.justices.heart, justice_memory: ctx.cast.justices.memory })[key];

/** A justice's personality (Max's words, content/judge-persona.md), or "" until written. */
export const justicePersonality = (ctx: Pick<CourtContext, "cast">, key: JusticeKey) =>
  ({ justice_letter: ctx.cast.personalities.letter, justice_heart: ctx.cast.personalities.heart, justice_memory: ctx.cast.personalities.memory })[key];

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

  // ---------- appeals (SPEC §8.7) ----------

  /** Why this case can't be appealed, or null if it can. One appeal per case; never from contempt. */
  appealBlocked(c: CaseRow): string | null {
    if (c.status === "contempt") return "The court doesn't hear appeals from contempt.";
    if (c.status === "appealed") return "The appeal is already being heard.";
    if (c.status !== "ruled" && c.status !== "too_close") return "Only a decided case can be appealed.";
    if (this.filings(c.id, true).some((f) => f.kind === "appeal")) return "This case has already had its appeal. One appeal per case!";
    return null;
  }

  /** A party appeals with new evidence. The appeal hearing starts right away. */
  fileAppeal(caseId: number, party: string, evidence: string): void {
    const c = this.getCase(caseId);
    if (!c) throw new AppealError("The court can't find that case.");
    const blocked = this.appealBlocked(c);
    if (blocked) throw new AppealError(blocked);
    const pid = this.personId(party);
    const side = pid && pid === c.plaintiff_id ? "plaintiff" : pid && pid === c.defendant_id ? "defendant" : null;
    if (!side) throw new AppealError("Only the two parties can appeal.");
    const author = side === "plaintiff" ? c.plaintiff : c.defendant;
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare("INSERT INTO filings(case_id, author, author_id, kind, body, created_at) VALUES (?, ?, ?, 'appeal', ?, ?)")
        .run(c.id, author, pid, evidence, Date.now());
      this.setStatus(c.id, "appealed");
    })();
    this.emit(c.id, "clerk", "appeal.filed", `${author} appeals! The court will look for new evidence.`, { by: author });
    void this.start(c.id);
  }

  private async runAppeal(c: CaseRow): Promise<void> {
    const code = await this.ctx.familyCode.refresh();
    const caseType = (c.type as CaseType) ?? "complaint";
    const original = this.data<RulingData>(c.id, "ruling.decided")!;

    // The appeal filing gets the contempt screen too.
    if (this.filings(c.id, true).some((f) => f.contempt_noul === null)) await this.screenMore(c);
    const appeal = this.filings(c.id, true).find((f) => f.kind === "appeal")!;
    if (appeal.struck) {
      if (!this.lastEvent(c.id, "appeal.dismissed")) {
        this.emit(c.id, "judge", "appeal.dismissed", "Appeal dismissed! Trying to sway the court doesn't work on appeal either.", { reason: "contempt" });
      }
      return this.closeAppeal(c, original, null);
    }

    // Is there anything new? (one noul; the original record vs. the appeal filing)
    let fresh = this.data<{ p: number }>(c.id, "appeal.reviewed");
    if (!fresh) {
      const state = {
        case: buildState({ case: c, filings: [] }).case,
        original_record: this.filings(c.id).filter((f) => f.kind !== "appeal").map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
        new_filing: { author: appeal.author, kind: "appeal", body: appeal.body },
      };
      const res = await this.ctx.jev.ask(state, { new_evidence: newEvidenceQuestion() });
      fresh = { p: res.answers.new_evidence.noul };
      this.emit(
        c.id,
        "judge",
        "appeal.reviewed",
        fresh.p >= APPEAL_NEW_EVIDENCE ? "There's something new here. The panel will hear the appeal." : "The judge reads the appeal closely…",
        fresh,
      );
    }
    if (fresh.p < APPEAL_NEW_EVIDENCE) {
      if (!this.lastEvent(c.id, "appeal.dismissed")) {
        this.emit(c.id, "judge", "appeal.dismissed", "Appeal dismissed: nothing new. The original ruling stands.", { reason: "nothing_new", p: fresh.p });
      }
      return this.closeAppeal(c, original, null);
    }

    // Round 1: the whole record, new evidence included, same precedent as the trial.
    let delib = this.data<DeliberationData>(c.id, "appeal.deliberation.done");
    if (!delib) {
      const check = this.data<PrecedentCheck>(c.id, "precedent.checked") ?? { candidates: [], kept: [] };
      const precedent = check.kept;
      const memoryRecusal = precedent.length ? undefined : check.candidates.length ? RECUSAL.noRelevantPrecedent : RECUSAL.noPrecedent;
      const questions = deliberationQuestions({ case: c, caseType, hasPrecedent: precedent.length > 0, sentencingLevels: code.sentencing });
      const state = buildState({
        case: { ...c, type: caseType },
        filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
        familyCode: code.text,
        precedent,
        computedFacts: { ...this.computedFacts(c), round: "appeal" },
      });
      this.emit(c.id, "judge", "appeal.deliberation.started", "The justices take a fresh look at the whole case…");
      const res = await this.ctx.jev.ask(state, questions);
      delib = { model: res.model, answers: res.answers as Record<string, unknown>, precedent, memoryRecusal };
      this.emit(c.id, "judge", "appeal.deliberation.done", "The justices have voted on the appeal.", delib);
    }

    let decided = this.data<RulingData & { result: "affirmed" | "reversed" }>(c.id, "appeal.decided");
    if (!decided) {
      const r1 = this.decideRuling(c, caseType, code, delib);
      const key = (r: RulingData) => (r.kind === "too_close" ? "compromise" : r.decision?.outcome ?? r.kind);
      const result = key(r1) === key(original) ? "affirmed" : "reversed";
      decided = { ...r1, result };
      this.saveRuling(c, r1, 1);
      this.emit(c.id, "judge", "appeal.decided", `On appeal, the panel ${result === "affirmed" ? "AFFIRMS" : "REVERSES"}. ${this.rulingMessage(c, caseType, r1)}`, decided);
    }

    if (!this.lastEvent(c.id, "appeal.opinion.written")) {
      const facts = this.opinionFacts(c, code, decided, null, 1);
      facts.articles = await this.relevantArticles(c, code, facts.articles);
      const op = await writeOpinion(this.ctx.ollama, this.ctx.persona(), facts, this.ctx.log);
      this.ctx.db
        .prepare("UPDATE rulings SET opinion_md = ?, bench_verdict = ?, cited_articles_json = ? WHERE case_id = ? AND round = 1")
        .run(op.opinion_md, op.bench_verdict, JSON.stringify(op.cited_articles), c.id);
      this.emit(c.id, "clerk", "appeal.opinion.written", "The clerk reads the opinion on appeal.", op);
    }
    return this.closeAppeal(c, original, decided);
  }

  private async closeAppeal(c: CaseRow, original: RulingData, decided: (RulingData & { result: string }) | null) {
    const id = c.id;
    if (this.lastEvent(id, "appeal.closed")) return;
    const ruling = decided ?? original;
    const status: CaseStatus = ruling.kind === "too_close" ? "too_close" : "ruled";
    this.ctx.db.prepare("UPDATE cases SET status = ?, ruled_at = ? WHERE id = ?").run(status, Date.now(), id);
    const granted = needsParentOk(ruling, c.type);
    if (granted) this.ctx.db.prepare("UPDATE cases SET approval = 'pending' WHERE id = ? AND approval IS NULL").run(id);

    await this.syncRecord(id);
    const L = labelsFor(this.ctx.people, this.getCase(id)!);
    const headline = decided
      ? `On appeal, the court ${decided.result === "affirmed" ? "AFFIRMED" : "REVERSED"} the ruling. ${decided.winner ? `It's now for ${L.relabel(decided.winner)}.` : "It's too close to call, so the court orders a compromise."}`
      : "The appeal was dismissed, so the original ruling stands.";
    await this.sendNotices(id, ruling, { headline, kind: "appeal.notices.sent" });
    if (decided) await this.recordVoice(id, 1);
    this.emit(id, "bailiff", "appeal.closed", "BANG! The appeal is decided. Court is adjourned.", { status, result: decided?.result ?? "dismissed" });
  }

  // ---------- mistrial (SPEC §8.8) ----------

  private vacatedChecked = new Set<number>();

  private async checkpointBeforeRuling(c: CaseRow) {
    if (!this.ctx.cfg.MISTRIAL_ENABLED) return;
    if (this.lastEvent(c.id, "checkpoint.created") || this.lastEvent(c.id, "checkpoint.failed")) return;
    try {
      const id = await this.ctx.spriteEnv.create(`pre-ruling ${caseLabel(c.number).replace("Case #", "case-")}`);
      this.emit(c.id, "clerk", "checkpoint.created", `The clerk saves a copy of the whole courthouse, just in case. (Checkpoint ${id}.)`, { id, createdAt: Date.now() });
    } catch (err) {
      this.ctx.log(`[mistrial] checkpoint failed: ${(err as Error).message}`);
      this.emit(c.id, "clerk", "checkpoint.failed", "The clerk couldn't save a copy of the courthouse, so this case can't have a mistrial.");
    }
  }

  /** Why a mistrial can't be declared, or the checkpoint to restore. All four guards are required. */
  async mistrialCheck(caseId: number): Promise<{ ok: true; checkpoint: string } | { ok: false; reason: string }> {
    const cfg = this.ctx.cfg;
    if (!cfg.MISTRIAL_ENABLED) return { ok: false, reason: "Mistrials are only allowed on the courthouse Sprite." };
    if (!cfg.BOX_RECORDS_FOLDER_ID) return { ok: false, reason: "A mistrial needs the Box records folder, so the record can remember." };
    const c = this.getCase(caseId);
    if (!c || !["ruled", "too_close"].includes(c.status) || !c.ruled_at) return { ok: false, reason: "Only a decided case can be declared a mistrial." };
    const latest = this.ctx.db
      .prepare("SELECT id FROM cases WHERE status IN ('ruled','too_close','contempt') ORDER BY ruled_at DESC, id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    const later = this.ctx.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE id != ? AND (number > ? OR created_at > ?)").get(c.id, c.number, c.ruled_at) as { n: number };
    const laterFilings = this.ctx.db.prepare("SELECT COUNT(*) AS n FROM filings WHERE case_id = ? AND created_at > ?").get(c.id, c.ruled_at) as { n: number };
    if (latest?.id !== c.id || later.n > 0 || laterFilings.n > 0) return { ok: false, reason: "Later cases are on the docket, so time can't be rewound past them." };
    const r = this.ctx.db.prepare("SELECT checkpoint_id FROM rulings WHERE case_id = ? AND round = 0").get(c.id) as { checkpoint_id: string | null } | undefined;
    if (!r?.checkpoint_id || !CHECKPOINT_ID.test(r.checkpoint_id)) return { ok: false, reason: "There's no saved copy of the courthouse from before this ruling." };
    const deployed = Number(this.ctx.deployId);
    if (!this.ctx.deployId || !Number.isFinite(deployed)) return { ok: false, reason: "The deploy stamp (data/DEPLOY_ID) is missing, so rewinding could roll back the code." };
    let found;
    try {
      found = (await this.ctx.spriteEnv.list()).find((x) => x.id === r.checkpoint_id);
    } catch (err) {
      return { ok: false, reason: `Couldn't list checkpoints: ${(err as Error).message}` };
    }
    if (!found) return { ok: false, reason: "That checkpoint is gone (only the last few are kept)." };
    if (found.createdAt <= deployed * 1000) return { ok: false, reason: "That checkpoint is older than the current code. Restoring it would roll back a deploy." };
    return { ok: true, checkpoint: found.id };
  }

  /** Stamp the Box record VACATED, then rewind the Sprite. Throws MistrialError if any guard fails. */
  async declareMistrial(caseId: number): Promise<{ checkpoint: string; delayMs: number }> {
    const check = await this.mistrialCheck(caseId);
    if (!check.ok) throw new MistrialError(check.reason);
    const c = this.getCase(caseId)!;
    const name = recordName(c.number);
    const md = vacatedBanner(caseLabel(c.number), new Date()) + renderRecord(caseView(c, this.ctx), this.ctx.cast.court);
    const r = this.ctx.db.prepare("SELECT box_file_id FROM rulings WHERE case_id = ? AND round = 0").get(caseId) as { box_file_id: string | null };
    try {
      if (r.box_file_id) await this.ctx.box.uploadVersion(r.box_file_id, name, md);
      else await this.ctx.box.upsertText(this.ctx.cfg.BOX_RECORDS_FOLDER_ID!, name, md);
    } catch (err) {
      throw new MistrialError(`Box didn't take the VACATED record, so the court won't rewind (nothing would remember): ${(err as Error).message}`);
    }
    this.emit(caseId, "court", "mistrial.declared", "MISTRIAL! The Executive Branch rewinds time…", { checkpoint: check.checkpoint });
    const delayMs = this.ctx.cfg.MISTRIAL_RESTORE_DELAY_MS;
    this.ctx.spriteEnv.restoreDetached(check.checkpoint, delayMs);
    this.ctx.log(`[mistrial] ${name}: restoring ${check.checkpoint} in ${delayMs} ms`);
    return { checkpoint: check.checkpoint, delayMs };
  }

  /** On resume: if Box says this case was vacated, close it as vacated instead of re-ruling it. */
  private async vacatedInBox(c: CaseRow): Promise<boolean> {
    const folder = this.ctx.cfg.BOX_RECORDS_FOLDER_ID;
    if (!this.ctx.cfg.MISTRIAL_ENABLED || !folder || this.vacatedChecked.has(c.id)) return false;
    this.vacatedChecked.add(c.id);
    if (c.status !== "deliberating" && c.status !== "gathering") return false; // a checkpoint is only taken here
    try {
      const fileId = await this.ctx.box.findInFolder(folder, recordName(c.number));
      if (!fileId || !(await this.ctx.box.downloadText(fileId)).includes(VACATED_MARKER)) return false;
    } catch (err) {
      this.ctx.log(`[mistrial] couldn't check Box for ${recordName(c.number)}: ${(err as Error).message}`);
      return false;
    }
    this.ctx.db.prepare("UPDATE cases SET status = 'vacated', ruled_at = ? WHERE id = ?").run(Date.now(), c.id);
    this.emit(c.id, "court", "case.vacated", "Mistrial! These proceedings never happened. (The Box record remembers.)");
    this.emit(c.id, "bailiff", "case.closed", "The case is closed. It never happened.", { status: "vacated" });
    return true;
  }

  // ---------- which articles the opinion may cite ----------

  /**
   * One batched Jev request: "Article N is relevant to this dispute" for every article; the opinion
   * may only cite those at or above ARTICLE_RELEVANCE. (On fc-court an opinion cited Article 3,
   * Dessert, in a video-game case.) Stored on an event, so the appeal opinion reuses it.
   */
  private async relevantArticles(c: CaseRow, code: FamilyCode, all: { number: number; title: string }[]): Promise<{ number: number; title: string }[]> {
    if (!all.length) return [];
    let check = this.data<{ scores: { number: number; p: number }[]; allowed: number[] }>(c.id, "articles.checked");
    if (!check) {
      try {
        const articles = code.articles.map((a) => ({ ref: `A${a.number}`, number: a.number, title: a.title, text: a.body }));
        const questions = Object.fromEntries(articles.map((a) => [`article_${a.ref}`, articleRelevanceQuestion(a.ref)]));
        const state = {
          case: buildState({ case: c, filings: [] }).case,
          filings: this.filings(c.id, true).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
          articles,
        };
        const res = await this.ctx.jev.ask(state, questions);
        const answers = res.answers as Record<string, { noul: number }>;
        const scores = articles.map((a) => ({ number: a.number, p: Number(answers[`article_${a.ref}`]?.noul ?? 0) }));
        check = { scores, allowed: scores.filter((x) => x.p >= ARTICLE_RELEVANCE).map((x) => x.number) };
        const names = check.allowed.map((n) => `Article ${n}`);
        this.emit(
          c.id,
          "clerk",
          "articles.checked",
          names.length ? `The clerk marks the relevant laws: ${names.join(", ")}.` : "The clerk finds no article of the Family Code that fits this one.",
          check,
        );
      } catch (err) {
        // Out of Jev budget, or Jev unreachable: write the opinion without citing any article.
        this.ctx.log(`[opinion] couldn't check article relevance: ${(err as Error).message}`);
        return [];
      }
    }
    const allowed = new Set(check.allowed);
    return all.filter((a) => allowed.has(a.number));
  }

  // ---------- counsel's remarks ----------

  /**
   * Counsel may mutter a line into the transcript while watching its own client's hearing ("he has
   * a good point"). Remarks are events, never filings: they are never sent to Jev, so they can't
   * sway the ruling. At most 2 per case, one line each.
   */
  addRemark(caseId: number, text: string): void {
    const c = this.getCase(caseId);
    if (!c) throw new RemarkError("The court can't find that case.");
    if (c.filed_by !== "lawyer") throw new RemarkError("Counsel can only speak up in cases counsel filed.");
    const line = text.replace(/\s+/g, " ").trim().slice(0, MAX_REMARK_CHARS);
    if (!line) throw new RemarkError("Counsel didn't say anything.");
    const n = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE case_id = ? AND kind = 'counsel.remark'").get(caseId) as { n: number }).n;
    if (n >= MAX_REMARKS) throw new RemarkError("Counsel has said enough for this case.");
    this.emit(caseId, "counsel", "counsel.remark", `${this.ctx.cast.lawyer}: “${line}”`, { text: line });
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

  private async recordVoice(caseId: number, round = 0) {
    const c = this.getCase(caseId)!;
    const r = this.ctx.db.prepare("SELECT bench_verdict FROM rulings WHERE case_id = ? AND round = ?").get(caseId, round) as
      | { bench_verdict: string | null }
      | undefined;
    if (!r?.bench_verdict) return;
    const prefix = round ? "appeal." : "";
    // The judge ends with his catchphrase ("The end!!!"); the page bangs the gavel right after it.
    const result = await this.ctx.voice.speak(c.number, spokenVerdict(r.bench_verdict, this.ctx.cast.catchphrase), round);
    if (result.status === "ready") {
      this.ctx.db.prepare("UPDATE rulings SET audio_path = ? WHERE case_id = ? AND round = ?").run(result.path, caseId, round);
      this.emit(caseId, "judge", `${prefix}voice.ready`, "The judge clears their throat…", { round });
    } else if (result.status === "no_budget") {
      this.emit(caseId, "judge", `${prefix}voice.unavailable`, "The judge has lost their voice for today, so the verdict is in writing.", { reason: "no_budget", round });
    } else if (result.status === "failed") {
      this.emit(caseId, "judge", `${prefix}voice.unavailable`, "The judge's microphone isn't working right now, so the verdict is in writing.", { reason: "failed", round });
    }
  }

  // ---------- notices (AgentMail) ----------

  private async sendNotices(caseId: number, ruling: RulingData, opts: { headline?: string; kind?: string } = {}) {
    const c = this.getCase(caseId)!;
    const L = labelsFor(this.ctx.people, c);
    // Each recipient gets their own link to this one case: no passcode needed (see /v/:token).
    const linkFor = (pid: string) => `${this.ctx.cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/v/${this.viewTokenFor(caseId, pid)}`;
    const label = caseLabel(c.number);
    const title = L.relabel(c.title);
    const headline = opts.headline ??
      (ruling.kind === "too_close"
        ? "It was too close to call, so the court ordered a compromise."
        : ruling.kind === "contempt"
          ? `${L.relabel(ruling.contemnor ?? "")} was held in contempt of court.`
          : `The court ruled for ${L.relabel(ruling.winner ?? "")}${ruling.decision?.vote ? ` (${ruling.decision.vote})` : ""}.${ruling.sentenceText ? ` Sentence: ${ruling.sentenceText}.` : ""}`);
    const sent: string[] = [];
    for (const pid of [...new Set([c.plaintiff_id, c.defendant_id].filter(Boolean) as string[])]) {
      const person = this.ctx.people.find((p) => p.id === pid);
      if (!person?.email) continue;
      const contemnorId = ruling.kind === "contempt" ? (pid === c.plaintiff_id && ruling.contemnor === c.plaintiff) || (pid === c.defendant_id && ruling.contemnor === c.defendant) : false;
      const l = contemnorId
        ? contemptLetter({ court: this.ctx.cast.court, alias: person.alias, caseLabel: label, title, sentence: ruling.sentenceText ?? "", url: linkFor(pid) })
        : rulingLetter({ court: this.ctx.cast.court, alias: person.alias, caseLabel: label, title, headline, url: linkFor(pid) });
      if ((await this.ctx.mailer.send(person, l)) === "sent") sent.push(person.alias);
    }
    if (sent.length) this.emit(caseId, "clerk", opts.kind ?? "notices.sent", `The clerk emails notice of the ruling to ${sent.join(" and ")}.`, { sent });
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
    // After a mistrial rewinds the Sprite, the case comes back "open". Box remembers it was vacated.
    if (await this.vacatedInBox(c)) return;
    if (c.status === "appealed") return this.runAppeal(c);
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

    // 5. Deliberation (a checkpoint first, so a mistrial can rewind to before the ruling)
    this.setStatus(caseId, "deliberating");
    let delib = this.data<DeliberationData>(caseId, "deliberation.done");
    if (!delib) {
      await this.checkpointBeforeRuling(c);
      delib = await this.deliberate(c, caseType, code);
    }

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
      const { scored, kept } = keepRelevant(candidates, res.answers as Record<string, { noul: number }>);
      check = {
        candidates: scored.map(({ p, relevance }) => ({ ref: p.ref!, number: p.number, title: p.title ?? "", p: relevance })),
        kept,
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
          : result === "failed"
            ? "The summons email didn't go through, so please answer here in person: tap “Tell your side”."
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

  /** The one case a summons token or a view token (from a ruling email) opens, read-only. */
  resolveViewToken(token: string): number | null {
    const s = this.ctx.db.prepare("SELECT case_id FROM summons WHERE token = ?").get(token) as { case_id: number } | undefined;
    if (s) return s.case_id;
    const l = this.ctx.db.prepare("SELECT case_id FROM case_links WHERE token = ?").get(token) as { case_id: number } | undefined;
    return l?.case_id ?? null;
  }

  /** A person's link to one case: their summons token if they were summoned, otherwise a view token. */
  viewTokenFor(caseId: number, personId: string): string {
    const s = this.ctx.db.prepare("SELECT token FROM summons WHERE case_id = ? AND person_id = ? ORDER BY id DESC LIMIT 1").get(caseId, personId) as
      | { token: string }
      | undefined;
    if (s) return s.token;
    const existing = this.ctx.db.prepare("SELECT token FROM case_links WHERE case_id = ? AND person_id = ?").get(caseId, personId) as { token: string } | undefined;
    if (existing) return existing.token;
    const token = randomBytes(32).toString("base64url");
    this.ctx.db.prepare("INSERT INTO case_links(token, case_id, person_id, created_at) VALUES (?, ?, ?, ?)").run(token, caseId, personId, Date.now());
    return token;
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
    const data = this.decideRuling(c, caseType, code, delib);
    this.saveRuling(c, data);
    const cp = this.data<{ id: string }>(c.id, "checkpoint.created");
    if (cp?.id) this.ctx.db.prepare("UPDATE rulings SET checkpoint_id = ? WHERE case_id = ? AND round = 0").run(cp.id, c.id);
    this.emit(c.id, "judge", "ruling.decided", this.rulingMessage(c, caseType, data), data);
    return data;
  }

  private rulingMessage(c: CaseRow, caseType: CaseType, data: RulingData): string {
    const decision = data.decision!;
    const { winner, confidencePct, sentenceText } = data;
    let msg: string;
    if (decision.status === "ruled") {
      const recused = decision.seats.some((s) => s.status === "recused");
      msg = `The panel rules ${decision.vote}${recused ? " (one justice recused)" : ""} for ${winner}. The court is ${confidencePct}% sure.`;
      if (caseType === "petition" && decision.outcome === "plaintiff") msg += " Recommended to the Executive Branch (a parent) for approval.";
      if (sentenceText) msg += ` Sentence: ${sentenceText}.`;
    } else {
      msg = decision.lean
        ? `Too close to call (leaning ${decision.lean === "plaintiff" ? c.plaintiff : c.defendant} ${decision.vote}, only ${confidencePct}% sure). The court will order a compromise.`
        : `Too close to call: the justices split ${decision.vote} and strongly disagree. The court will order a compromise.`;
    }
    return msg;
  }

  /** SPEC §8.4 applied to a deliberation (pure: no writes). */
  private decideRuling(c: CaseRow, caseType: CaseType, code: FamilyCode, delib: DeliberationData): RulingData {
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
    // No "% sure" on a split: there's no side the court leans to.
    const confidencePct = decision.reason === "tie" ? null : Math.round(decision.caseConfidence * 100);
    return {
      kind: decision.status,
      decision,
      winner,
      sentenceLevel: decision.sentenceLevel,
      sentenceText,
      confidencePct,
    };
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

  private saveRuling(c: CaseRow, r: RulingData, round = 0) {
    const d = r.decision;
    const outcome = r.kind === "contempt" ? "contempt" : d?.outcome ?? "compromise";
    const panel = d ? d.seats.map((s) => ({ ...s, name: justiceName(this.ctx, s.key) })) : null;
    this.ctx.db
      .prepare(
        `INSERT INTO rulings(case_id, round, panel_json, outcome, vote, case_confidence, sentence_level, sentence_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(case_id, round) DO NOTHING`,
      )
      .run(c.id, round, panel ? JSON.stringify(panel) : null, outcome, d?.vote ?? null, d?.caseConfidence ?? null, r.sentenceLevel, r.sentenceText, Date.now());
  }

  // Steps 7–9: opinion, record, gavel
  private async finish(c: CaseRow, code: FamilyCode, ruling: RulingData, inAbsentia?: string | null): Promise<void> {
    const id = c.id;
    if (!this.lastEvent(id, "opinion.written")) {
      const facts = this.opinionFacts(c, code, ruling, inAbsentia ?? null);
      facts.articles = await this.relevantArticles(c, code, facts.articles);
      const op = await writeOpinion(this.ctx.ollama, this.ctx.persona(), facts, this.ctx.log);
      this.ctx.db
        .prepare("UPDATE rulings SET opinion_md = ?, bench_verdict = ?, cited_articles_json = ? WHERE case_id = ? AND round = 0")
        .run(op.opinion_md, op.bench_verdict, JSON.stringify(op.cited_articles), id);
      this.emit(id, "clerk", "opinion.written", "The clerk reads the court's opinion.", op);
    }

    const final: CaseStatus = ruling.kind === "contempt" ? "contempt" : ruling.kind === "too_close" ? "too_close" : "ruled";
    this.ctx.db.prepare("UPDATE cases SET status = ?, ruled_at = ? WHERE id = ?").run(final, Date.now(), id);
    // A granted petition is only a recommendation until a parent approves it.
    const granted = needsParentOk(ruling, this.getCase(id)!.type);
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

  private opinionFacts(c: CaseRow, code: FamilyCode, r: RulingData, inAbsentia: string | null, round = 0): OpinionFacts {
    const d = r.decision;
    const sideName = (s: Side) => (s === "plaintiff" ? c.plaintiff : c.defendant);
    const justices =
      d?.seats.map((s) => ({
        name: justiceName(this.ctx, s.key),
        personality: justicePersonality(this.ctx, s.key) || undefined,
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
      dissenterPersonality: dissent ? justicePersonality(this.ctx, dissent.key) || undefined : undefined,
      sentence: r.sentenceLevel !== null && r.sentenceText ? { level: r.sentenceLevel, text: r.sentenceText } : undefined,
      inAbsentia: inAbsentia ?? undefined,
      articles: code.articles.map((a) => ({ number: a.number, title: a.title })),
      filings: this.filings(c.id).map((f) => ({ author: f.author, kind: f.kind, body: f.body })),
      appeal: round === 1 ? this.appealFacts(c, r) : undefined,
    };
  }

  private appealFacts(c: CaseRow, r: RulingData): OpinionFacts["appeal"] {
    const original = this.data<RulingData>(c.id, "ruling.decided");
    const filing = this.filings(c.id).find((f) => f.kind === "appeal");
    const describe = (x?: RulingData | null) =>
      !x ? "unknown" : x.kind === "too_close" ? "too close to call (compromise)" : x.winner ? `for ${x.winner}` : x.kind;
    const key = (x?: RulingData | null) => (x?.kind === "too_close" ? "compromise" : x?.decision?.outcome ?? x?.kind);
    return {
      by: filing?.author ?? "",
      evidence: filing?.body ?? "",
      original: describe(original),
      result: key(original) === key(r) ? "affirmed" : "reversed",
    };
  }
}
