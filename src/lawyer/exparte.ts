/**
 * The ex parte demo (SPEC §9.4): a button, NOT a tool the LLM can call. From the lawyer's Sprite it
 * tries the court's own connectors, which the connector access policies keep away from it:
 *   1. a Box read of the Family Code (or the Box identity if no file id is configured),
 *   2. an AgentMail send, addressed to the clerk's own inbox, so even a leaky policy only ever
 *      emails the clerk,
 *   3. a text-to-speech call through the court's ElevenLabs connector.
 * Separation of powers is enforced by infrastructure: each attempt should come back 403.
 */
import { execFile } from "node:child_process";
import type { Config } from "../shared/config.ts";
import { GatewayError, type Gateway, type Provider } from "../shared/gateway.ts";

export type Verdict = "denied" | "allowed" | "error";

export interface Attempt {
  motion: string;
  connector: string;
  verdict: Verdict;
  status: number | null;
  detail: string;
}

export interface ExParteResult {
  sprite: string | null;
  attempts: Attempt[];
  headline: string;
}

function spriteName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("sprite-env", ["info"], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve((JSON.parse(stdout) as { sprite_name?: string }).sprite_name ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function attempt(gateway: Gateway, provider: Provider, motion: string, connector: string, path: string, init: RequestInit = {}): Promise<Attempt> {
  try {
    const res = await gateway.gw(provider, path, { ...init, signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { motion, connector, verdict: "allowed", status: res.status, detail: "The connector let the lawyer through. Tighten its access policy!" };
    return { motion, connector, verdict: "error", status: res.status, detail: `The gateway answered HTTP ${res.status}.` };
  } catch (err) {
    if (err instanceof GatewayError && err.status === 403) {
      return { motion, connector, verdict: "denied", status: 403, detail: "403: this Sprite isn't on the connector's access policy." };
    }
    if (err instanceof GatewayError && err.status === 0 && /no connector found|needs ELEVENLABS_BASE/.test(err.message)) {
      return { motion, connector, verdict: "denied", status: null, detail: "The court's connector isn't even visible from this Sprite." };
    }
    if (err instanceof GatewayError && err.status === 401) {
      return { motion, connector, verdict: "error", status: 401, detail: "401: this demo only works from inside a Sprite." };
    }
    return { motion, connector, verdict: "error", status: err instanceof GatewayError ? err.status : null, detail: (err as Error).message };
  }
}

export async function exParte(cfg: Config, gateway: Gateway, opts: { sprite?: () => Promise<string | null> } = {}): Promise<ExParteResult> {
  const fileId = cfg.BOX_FAMILY_CODE_FILE_ID;
  const inbox = cfg.AGENTMAIL_INBOX_ID;
  const attempts = await Promise.all([
    attempt(gateway, "box", "Read the court's Family Code straight from Box", "Box", fileId ? `/2.0/files/${encodeURIComponent(fileId)}?fields=name` : "/2.0/users/me"),
    inbox
      ? attempt(gateway, "agentmail", "Email the witness directly", "AgentMail", `/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            to: [inbox],
            subject: "Ex parte test from counsel",
            text: "If you're reading this, the lawyer's Sprite was able to use the court's email connector. Tighten the AgentMail access policy to fc-court.",
          }),
        })
      : attempt(gateway, "agentmail", "Email the witness directly", "AgentMail", "/v0/auth/me"),
    attempt(gateway, "elevenlabs_tts", "Speak in the judge's voice", "ElevenLabs (text to speech)", `/v1/text-to-speech/${encodeURIComponent(cfg.ELEVENLABS_VOICE_ID ?? "voice")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Objection!", ...(cfg.ELEVENLABS_MODEL_ID ? { model_id: cfg.ELEVENLABS_MODEL_ID } : {}) }),
    }),
  ]);
  const allDenied = attempts.every((a) => a.verdict === "denied");
  const anyAllowed = attempts.some((a) => a.verdict === "allowed");
  const headline = allDenied
    ? "Motion to contact the witness directly: DENIED by the court's connector policy."
    : anyAllowed
      ? "Motion GRANTED?! The lawyer reached the court's own connectors. Tighten their access policies to fc-court."
      : "The demo couldn't reach a verdict. See the details below.";
  return { sprite: await (opts.sprite ?? spriteName)(), attempts, headline };
}
