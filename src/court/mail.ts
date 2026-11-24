/**
 * AgentMail (court only): summonses, notices of ruling, contempt notices.
 *
 * The connector's key is scoped to the clerk's inbox, so only
 * POST /v0/inboxes/{inbox}/messages/send is used (GET /v0/inboxes is 403 by design).
 * Recipients are only people in people.json with an email. Every send spends EMAIL_DAILY.
 */
import { RecessError, type Budget } from "../shared/budget.ts";
import { GatewayError, type Gateway } from "../shared/gateway.ts";
import type { Person } from "../shared/people.ts";

export type SendResult = "sent" | "no_email" | "disabled" | "budget" | "failed";

export interface Letter {
  subject: string;
  text: string;
  html: string;
}

/** Transient failures (a cold gateway's first call answered 503 on fc-court) get two more tries. */
export const MAIL_RETRY_DELAYS_MS = [400, 1500];
const transient = (status: number) => status === 429 || status >= 500;

export class Mailer {
  constructor(
    private readonly opts: { gateway: Gateway; budget: Budget; inboxId?: string; log: (m: string) => void; retryDelaysMs?: number[] },
  ) {}

  get enabled() {
    return !!this.opts.inboxId;
  }

  async send(to: Person | undefined, letter: Letter): Promise<SendResult> {
    if (!this.opts.inboxId) return "disabled";
    if (!to?.email) return "no_email";
    try {
      this.opts.budget.spend("email", 1);
    } catch (err) {
      if (err instanceof RecessError) return "budget";
      throw err;
    }
    // One email, one budget unit, however many tries it takes.
    const delays = this.opts.retryDelaysMs ?? MAIL_RETRY_DELAYS_MS;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      let retry = false;
      try {
        const res = await this.opts.gateway.gw("agentmail", `/v0/inboxes/${encodeURIComponent(this.opts.inboxId)}/messages/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: [to.email], subject: letter.subject, text: letter.text, html: letter.html }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          if (attempt > 0) this.opts.log(`[mail] "${letter.subject}" sent on try ${attempt + 1}`);
          return "sent";
        }
        this.opts.log(`[mail] AgentMail answered HTTP ${res.status} for "${letter.subject}" (try ${attempt + 1})`);
        retry = transient(res.status);
      } catch (err) {
        this.opts.log(`[mail] couldn't send "${letter.subject}" (try ${attempt + 1}): ${(err as Error).message}`);
        retry = !(err instanceof GatewayError) || transient(err.status); // 401/403 won't fix themselves
      }
      if (!retry) break;
    }
    return "failed";
  }
}

// ---------- letters (PG, friendly, aliases only) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function letter(subject: string, paragraphs: string[], link?: { href: string; label: string }, court = "Family Court"): Letter {
  const sign = `The Clerk of ${court}`;
  const text = [...paragraphs, ...(link ? [`${link.label}: ${link.href}`] : []), "", sign].join("\n\n");
  const html = `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#2b2118">
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
${link ? `<p><a href="${esc(link.href)}" style="display:inline-block;background:#b8862b;color:#1e1406;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold;font-family:system-ui,sans-serif">${esc(link.label)}</a></p>` : ""}
<p style="color:#6f6152">${esc(sign)} ⚖️</p></div>`;
  return { subject, text, html };
}

export function summonsLetter(o: { court: string; alias: string; caseLabel: string; title: string; otherParty: string; url: string; minutes: number }): Letter {
  return letter(
    `Summons: ${o.caseLabel}, ${o.title}`,
    [
      `Hear ye, hear ye, ${o.alias}!`,
      `${o.otherParty} has brought a case to ${o.court}, and the judge would like to hear your side before deciding.`,
      `Tap the button below to tell the court what happened (up to 1000 characters). If the court doesn't hear from you within ${o.minutes} minutes, it will decide without you.`,
      "Remember: argue your case. Bribing or bossing the judge is contempt of court!",
    ],
    { href: o.url, label: "Tell the court your side" },
    o.court,
  );
}

export function rulingLetter(o: { court: string; alias: string; caseLabel: string; title: string; headline: string; url: string }): Letter {
  return letter(`Notice of ruling: ${o.caseLabel}, ${o.title}`, [`Dear ${o.alias},`, `The court has ruled in ${o.caseLabel}, ${o.title}.`, o.headline], { href: o.url, label: "Read the ruling" }, o.court);
}

export function contemptLetter(o: { court: string; alias: string; caseLabel: string; title: string; sentence: string; url: string }): Letter {
  return letter(
    `Notice of contempt: ${o.caseLabel}, ${o.title}`,
    [
      `Dear ${o.alias},`,
      `The court found that your filing in ${o.caseLabel} tried to bribe, trick or boss around the judge. That's contempt of court, and the filing was struck from the record.`,
      `Your sentence: ${o.sentence}.`,
      "Next time, argue your case. The court is always happy to hear a good argument!",
    ],
    { href: o.url, label: "See the case" },
    o.court,
  );
}
