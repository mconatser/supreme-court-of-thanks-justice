import { describe, expect, it } from "vitest";
import {
  band,
  buildState,
  contemptQuestion,
  decide,
  deliberationQuestions,
  THRESHOLDS,
  type ChoiceAnswer,
  type JusticeKey,
} from "../src/shared/panel.ts";

const j = (pPlaintiff: number, confidence?: number): ChoiceAnswer => {
  const choice = pPlaintiff >= 0.5 ? "plaintiff" : "defendant";
  return {
    choice,
    confidence: confidence ?? Math.max(pPlaintiff, 1 - pPlaintiff),
    probabilities: { plaintiff: pPlaintiff, defendant: 1 - pPlaintiff },
  };
};

const panel = (letter: number, heart: number, memory?: number) => {
  const justices: Partial<Record<JusticeKey, ChoiceAnswer>> = { justice_letter: j(letter), justice_heart: j(heart) };
  if (memory !== undefined) justices.justice_memory = j(memory);
  return justices;
};

describe("decide (SPEC §8.4)", () => {
  it("a unanimous panel rules 3–0 with mean confidence for the winner", () => {
    const d = decide({ caseType: "declaration", justices: panel(0.9, 0.8, 0.85) });
    expect(d.status).toBe("ruled");
    expect(d.outcome).toBe("plaintiff");
    expect(d.vote).toBe("3–0");
    expect(d.caseConfidence).toBeCloseTo(0.85, 5);
    expect(d.sentenceLevel).toBeNull(); // declarations are never sentenced
  });

  it("a split panel rules 2–1 for the majority", () => {
    const d = decide({ caseType: "declaration", justices: panel(0.2, 0.15, 0.7) });
    expect(d.outcome).toBe("defendant");
    expect(d.vote).toBe("2–1");
    // mean of P(defendant): 0.8, 0.85, 0.3
    expect(d.caseConfidence).toBeCloseTo((0.8 + 0.85 + 0.3) / 3, 5);
  });

  it("always returns three seats; with no precedent Justice Memory is recused, not dropped", () => {
    const d = decide({ caseType: "declaration", justices: panel(0.9, 0.85) });
    expect(d.seats).toHaveLength(3);
    expect(d.seats[2]).toEqual({ key: "justice_memory", status: "recused", reason: "recused: no precedent yet" });
    expect(d.vote).toBe("2–0");
    expect(d.status).toBe("ruled");
  });

  it("a 1–1 tie on a two-justice panel is too close", () => {
    const d = decide({ caseType: "complaint", justices: panel(0.8, 0.3), sentence: { score: 3, confidence: 0.6 } });
    expect(d.status).toBe("too_close");
    expect(d.reason).toBe("tie");
    expect(d.outcome).toBeNull();
    expect(d.sentenceLevel).toBeNull();
  });

  it("is too close when case confidence is under 0.55", () => {
    const d = decide({ caseType: "declaration", justices: panel(0.52, 0.53, 0.51) });
    expect(d.status).toBe("too_close");
    expect(d.reason).toBe("low_case_confidence");
    expect(d.lean).toBe("plaintiff");
  });

  it("is too close when the justices' mean confidence is under 0.4", () => {
    const justices = {
      justice_letter: { ...j(0.7), confidence: 0.3 },
      justice_heart: { ...j(0.7), confidence: 0.35 },
      justice_memory: { ...j(0.7), confidence: 0.38 },
    };
    const d = decide({ caseType: "declaration", justices });
    expect(d.status).toBe("too_close");
    expect(d.reason).toBe("low_justice_confidence");
  });

  it("sentences only complaints the plaintiff wins, using round(score) clamped to the guidelines", () => {
    expect(decide({ caseType: "complaint", justices: panel(0.9, 0.9), sentence: { score: 2.6, confidence: 0.5 } }).sentenceLevel).toBe(3);
    expect(decide({ caseType: "complaint", justices: panel(0.9, 0.9), sentence: { score: 9, confidence: 0.5 } }).sentenceLevel).toBe(4);
    expect(decide({ caseType: "complaint", justices: panel(0.1, 0.1), sentence: { score: 3, confidence: 0.5 } }).sentenceLevel).toBeNull();
    expect(decide({ caseType: "petition", justices: panel(0.9, 0.9), sentence: { score: 3, confidence: 0.5 } }).sentenceLevel).toBeNull();
  });

  it("is robust to Jev's run-to-run drift on clear cases (±5 points never flips the outcome)", () => {
    // Deterministic pseudo-random noise, like two identical Jev runs disagreeing by a few points.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    for (const base of [[0.85, 0.8, 0.82], [0.15, 0.2, 0.25], [0.9, 0.75, 0.3]] as const) {
      const outcomes = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const noisy = base.map((p) => Math.min(0.99, Math.max(0.01, p + rnd() * 0.05)));
        const d = decide({ caseType: "declaration", justices: panel(noisy[0], noisy[1], noisy[2]) });
        outcomes.add(`${d.status}:${d.outcome}`);
      }
      expect(outcomes.size).toBe(1);
    }
  });
});

describe("bands", () => {
  it("uses 0.7 / 0.3 thresholds with an unsure middle", () => {
    expect(band(THRESHOLDS.yes)).toBe("yes");
    expect(band(0.95)).toBe("yes");
    expect(band(0.5)).toBe("unsure");
    expect(band(0.3)).toBe("unsure");
    expect(band(0.29)).toBe("no");
  });
});

describe("questions", () => {
  const c = { plaintiff: "Pip", defendant: "Sky Sister", relief: "Front seat for a week" };

  it("contempt questions name the filing they judge", () => {
    const q = contemptQuestion("F3");
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain('"F3"');
    expect(q.instructions).toContain("bribe, threaten, flatter");
  });

  it("deliberation drops justice_memory without precedent and adds sentence only for complaints", () => {
    const levels = ["a", "b", "c", "d", "e"];
    const noPrec = deliberationQuestions({ case: c, caseType: "complaint", hasPrecedent: false, sentencingLevels: levels });
    expect(Object.keys(noPrec).sort()).toEqual(["justice_heart", "justice_letter", "sentence"]);
    const withPrec = deliberationQuestions({ case: c, caseType: "declaration", hasPrecedent: true, sentencingLevels: levels });
    expect(Object.keys(withPrec).sort()).toEqual(["justice_heart", "justice_letter", "justice_memory"]);
    expect((withPrec.justice_letter as any).criteria).toEqual({
      plaintiff: "Pip prevails: Front seat for a week",
      defendant: "Sky Sister prevails",
    });
  });

  it("buildState caps precedent at 8", () => {
    const precedent = Array.from({ length: 12 }, (_, i) => ({ case: `#${i}`, question: "q", outcome: "o", vote: "3–0", articles: [] }));
    const s = buildState({
      case: { number: 1, title: "t", type: null, claim: "c", ...c },
      filings: [],
      precedent,
    });
    expect(s.precedent).toHaveLength(8);
  });
});
