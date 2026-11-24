/**
 * The spoken verdict (court only). Text to speech goes through the Custom API connector for
 * api.elevenlabs.io (ELEVENLABS_BASE): the official ElevenLabs connector answers "endpoint is not
 * supported" for TTS. Verified on fc-court-dev: POST /v1/text-to-speech/{voice_id} → 200 audio/mpeg.
 *
 * Each verdict is synthesized once and cached at data/audio/case-<n>.mp3. TTS_CHARS_DAILY guards
 * the free plan's ~10 minutes a month; when it runs out the judge has "lost their voice for today".
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecessError, type Budget } from "../shared/budget.ts";
import type { Gateway } from "../shared/gateway.ts";

export const BENCH_VERDICT_MAX = 300;

export type VoiceResult =
  | { status: "ready"; path: string; cached: boolean }
  | { status: "no_budget" | "disabled" | "failed" };

export class Voice {
  constructor(
    private readonly opts: {
      gateway: Gateway;
      budget: Budget;
      base?: string;
      voiceId?: string;
      modelId?: string;
      dataDir: string;
      log: (m: string) => void;
    },
  ) {}

  get enabled() {
    return !!(this.opts.base && this.opts.voiceId);
  }

  /** case-7.mp3 for the trial, case-7-appeal.mp3 for the ruling on appeal. */
  audioPath(caseNumber: number, round = 0) {
    return join(this.opts.dataDir, "audio", `case-${caseNumber}${round ? "-appeal" : ""}.mp3`);
  }

  hasAudio(caseNumber: number, round = 0) {
    return existsSync(this.audioPath(caseNumber, round));
  }

  async speak(caseNumber: number, text: string, round = 0): Promise<VoiceResult> {
    const path = this.audioPath(caseNumber, round);
    if (existsSync(path)) return { status: "ready", path, cached: true }; // never synthesize the same verdict twice
    if (!this.enabled) return { status: "disabled" };
    const words = text.trim().slice(0, BENCH_VERDICT_MAX);
    try {
      this.opts.budget.spend("tts_chars", words.length);
    } catch (err) {
      if (err instanceof RecessError) return { status: "no_budget" };
      throw err;
    }
    try {
      const res = await this.opts.gateway.gw("elevenlabs_tts", `/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId!)}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: words, ...(this.opts.modelId ? { model_id: this.opts.modelId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("audio/")) {
        this.opts.log(`[voice] TTS answered HTTP ${res.status} (${type || "no content type"})`);
        return { status: "failed" };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      mkdirSync(join(this.opts.dataDir, "audio"), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
      return { status: "ready", path, cached: false };
    } catch (err) {
      this.opts.log(`[voice] TTS failed: ${(err as Error).message}`);
      return { status: "failed" };
    }
  }
}
