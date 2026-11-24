/**
 * JSON shapes the browser sees. Every party name goes through labelsFor(), so the UI always shows
 * the person's current alias, even on cases filed before people.json changed.
 */
import { band, type Seat, type Side } from "../shared/panel.ts";
import { publicParty } from "../shared/people.ts";
import type { CourtContext } from "./context.ts";
import { FINAL_STATUSES, type CaseRow, type EventRow, type FilingRow, type RulingRow } from "./db.ts";
import { labelsFor, type Labels } from "./labels.ts";
import { caseLabel } from "./precedent.ts";

type StoredSeat = Seat & { name: string };

/** ready: ▶ playable · no_budget: "lost their voice for today" · unavailable: TTS failed · none: voice off */
function voiceStatus(ctx: CourtContext, c: CaseRow) {
  if (ctx.voice.hasAudio(c.number)) return { status: "ready", url: `/cases/${c.number}/verdict.mp3` };
  const e = ctx.db.prepare("SELECT data_json FROM events WHERE case_id = ? AND kind = 'voice.unavailable' ORDER BY id DESC LIMIT 1").get(c.id) as
    | { data_json: string | null }
    | undefined;
  if (e) return { status: JSON.parse(e.data_json ?? "{}").reason === "no_budget" ? "no_budget" : "unavailable", url: null };
  return { status: "none", url: null };
}

const currentAliasOf = (ctx: CourtContext, personId: string, L: Labels) => ctx.people.find((p) => p.id === personId)?.alias ?? L.plaintiff;

export function publicEvent(e: EventRow, labels?: Labels) {
  return {
    id: e.id,
    ts: e.ts,
    actor: e.actor,
    kind: e.kind,
    message: labels ? labels.relabel(e.message) : e.message,
    data: e.data_json ? JSON.parse(e.data_json) : null,
  };
}

/** Which way the voting justices leaned, e.g. { side: "plaintiff", vote: "2–1" }; null on a tie. */
export function leanOf(seats: StoredSeat[]): { side: Side; vote: string } | null {
  const voted = seats.filter((s) => s.status === "voted") as Extract<StoredSeat, { status: "voted" }>[];
  const p = voted.filter((s) => s.choice === "plaintiff").length;
  const d = voted.length - p;
  if (p === d) return null;
  return { side: p > d ? "plaintiff" : "defendant", vote: `${Math.max(p, d)}–${Math.min(p, d)}` };
}

const seatsOf = (r: Pick<RulingRow, "panel_json"> | undefined): StoredSeat[] => (r?.panel_json ? JSON.parse(r.panel_json) : []);

export function caseSummary(c: CaseRow, ctx: CourtContext) {
  const L = labelsFor(ctx.people, c);
  const r = ctx.db
    .prepare("SELECT outcome, vote, case_confidence, panel_json FROM rulings WHERE case_id = ? ORDER BY round DESC LIMIT 1")
    .get(c.id) as Pick<RulingRow, "outcome" | "vote" | "case_confidence" | "panel_json"> | undefined;
  const summons = ctx.db.prepare("SELECT person_id FROM summons WHERE case_id = ? AND status = 'pending'").all(c.id) as { person_id: string }[];
  const sideName = (s: Side) => (s === "plaintiff" ? L.plaintiff : L.defendant);
  const lean = r?.outcome === "compromise" ? leanOf(seatsOf(r)) : null;
  return {
    number: c.number,
    label: caseLabel(c.number),
    title: L.relabel(c.title),
    plaintiff: L.plaintiff,
    defendant: L.defendant,
    type: c.type,
    status: c.status,
    final: FINAL_STATUSES.has(c.status),
    createdAt: c.created_at,
    outcome: r?.outcome ?? null,
    winner: r?.outcome === "plaintiff" ? L.plaintiff : r?.outcome === "defendant" ? L.defendant : null,
    vote: r?.vote ?? null,
    confidencePct: r?.case_confidence != null ? Math.round(r.case_confidence * 100) : null,
    lean: lean ? { side: lean.side, party: sideName(lean.side), vote: lean.vote } : null,
    approval: c.approval ?? null,
    summoned: summons.map((s) => ctx.people.find((p) => p.id === s.person_id)?.alias).filter(Boolean),
  };
}

export function caseView(c: CaseRow, ctx: CourtContext, roles: string[] = []) {
  const L = labelsFor(ctx.people, c);
  const filings = ctx.db.prepare("SELECT * FROM filings WHERE case_id = ? ORDER BY id").all(c.id) as FilingRow[];
  const r = ctx.db.prepare("SELECT * FROM rulings WHERE case_id = ? ORDER BY round DESC LIMIT 1").get(c.id) as RulingRow | undefined;
  const code = ctx.familyCode.load();
  const sideName = (s: Side) => (s === "plaintiff" ? L.plaintiff : L.defendant);
  /** A cite is "P7" (case #0007), "L1" (landmark) or, from early Phase 1 rulings, a bare case number. */
  const cited = (ref: string | number) => {
    const s = String(ref);
    if (s.startsWith("L")) {
      const lm = ctx.landmarks.find(s);
      return { ref: s, label: `Landmark ${s}`, title: lm?.title ?? "", landmark: true };
    }
    const n = Number(s.replace(/^P/, ""));
    const k = ctx.db.prepare("SELECT * FROM cases WHERE number = ?").get(n) as CaseRow | undefined;
    return { ref: `P${n}`, number: n, label: caseLabel(n), title: k ? labelsFor(ctx.people, k).relabel(k.title) : "", landmark: false };
  };

  let ruling = null;
  if (r) {
    const stored = seatsOf(r);
    const seats = stored.map((s) =>
      s.status === "voted"
        ? {
            key: s.key,
            name: s.name,
            status: s.status,
            side: s.choice,
            party: sideName(s.choice),
            pct: Math.round(s.probabilities[s.choice] * 100),
            cites: (s.cites ?? []).map(cited),
          }
        : { key: s.key, name: s.name, status: s.status, reason: s.reason },
    );
    const lean = r.outcome === "compromise" ? leanOf(stored) : null;
    const citedArticles = r.cited_articles_json ? (JSON.parse(r.cited_articles_json) as number[]) : [];
    const struckAuthor = filings.find((f) => f.struck);
    ruling = {
      outcome: r.outcome,
      winner: r.outcome === "plaintiff" ? L.plaintiff : r.outcome === "defendant" ? L.defendant : null,
      contemnor: r.outcome === "contempt" && struckAuthor ? L.party(struckAuthor.author, struckAuthor.author_id) : null,
      vote: r.vote,
      confidencePct: r.case_confidence != null ? Math.round(r.case_confidence * 100) : null,
      lean: lean ? { side: lean.side, party: sideName(lean.side), vote: lean.vote } : null,
      seats,
      sentence: r.sentence_level != null ? { level: r.sentence_level, text: r.sentence_text } : null,
      petitionRecommended: c.type === "petition" && r.outcome === "plaintiff",
      voice: voiceStatus(ctx, c),
      opinionMd: L.relabel(r.opinion_md),
      benchVerdict: L.relabel(r.bench_verdict),
      citedArticles: citedArticles.map((n) => ({ number: n, title: code.articles.find((a) => a.number === n)?.title ?? "" })),
    };
  }

  return {
    ...caseSummary(c, ctx),
    claim: c.claim,
    relief: c.relief,
    filedBy: c.filed_by,
    ruledAt: c.ruled_at,
    running: ctx.hearings.isRunning(c.id),
    viewer: { isParent: roles.includes("parent") },
    // Court-passcode viewers share the family phone, so pending summonses link straight to testimony.
    summons: (ctx.db.prepare("SELECT person_id, token, status, sent_via FROM summons WHERE case_id = ? ORDER BY id").all(c.id) as {
      person_id: string;
      token: string;
      status: string;
      sent_via: string;
    }[]).map((s) => ({
      party: currentAliasOf(ctx, s.person_id, L),
      status: s.status,
      via: s.sent_via,
      url: s.status === "pending" ? `/summons/${s.token}` : null,
    })),
    filings: filings.map((f) => ({
      author: L.party(f.author, f.author_id),
      kind: f.kind,
      body: f.body, // as written by the party
      struck: !!f.struck,
      contempt: f.contempt_noul != null ? band(f.contempt_noul) : null,
    })),
    ruling,
  };
}

export function docketView(ctx: CourtContext, roles: string[] = []) {
  const cases = ctx.db.prepare("SELECT * FROM cases ORDER BY number DESC LIMIT 100").all() as CaseRow[];
  const code = ctx.familyCode.load();
  return {
    cast: ctx.cast,
    inSession: ctx.budget.inSession(),
    isParent: roles.includes("parent"),
    warnings: code.warnings,
    parties: ctx.people.map(publicParty),
    cases: cases.map((c) => caseSummary(c, ctx)),
  };
}
