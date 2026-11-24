/**
 * Daily spend guards. Pay As You Go has no caps, so these counters are the guardrail.
 * When one runs out, the court is "in recess until tomorrow" (HTTP 503).
 */
import type { DB } from "../court/db.ts";

export type BudgetKey = "jev" | "ollama" | "tts_chars" | "email";

export class RecessError extends Error {
  constructor(readonly key: BudgetKey) {
    super("Court is in recess until tomorrow.");
  }
}

/** Worst-case Jev calls for one hearing: screening, sufficiency, testimony screening, precedent relevance, deliberation. */
export const JEV_CALLS_PER_HEARING = 5;

export class Budget {
  constructor(
    private readonly db: DB,
    private readonly limits: Record<BudgetKey, number>,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** YYYY-MM-DD in the court's time zone. */
  today(): string {
    return this.now().toLocaleDateString("en-CA", { timeZone: this.timeZone });
  }

  used(key: BudgetKey): number {
    const row = this.db.prepare("SELECT used FROM budget WHERE day = ? AND key = ?").get(this.today(), key) as
      | { used: number }
      | undefined;
    return row?.used ?? 0;
  }

  remaining(key: BudgetKey): number {
    return Math.max(0, this.limits[key] - this.used(key));
  }

  canAfford(needs: Partial<Record<BudgetKey, number>>): boolean {
    return Object.entries(needs).every(([k, n]) => this.remaining(k as BudgetKey) >= (n ?? 0));
  }

  /** Atomically spend `n`; throws RecessError (and spends nothing) if it would go over. */
  spend(key: BudgetKey, n = 1): void {
    const day = this.today();
    const limit = this.limits[key];
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO budget(day, key, used) VALUES (?, ?, 0)").run(day, key);
      const res = this.db
        .prepare("UPDATE budget SET used = used + ? WHERE day = ? AND key = ? AND used + ? <= ?")
        .run(n, day, key, n, limit);
      if (res.changes === 0) throw new RecessError(key);
    });
    tx();
  }

  /** For display: which budgets are used up today. */
  exhausted(): BudgetKey[] {
    return (Object.keys(this.limits) as BudgetKey[]).filter((k) => this.remaining(k) <= 0);
  }

  /** Can the court take a new case right now? */
  inSession(): boolean {
    return this.canAfford({ jev: JEV_CALLS_PER_HEARING });
  }
}
