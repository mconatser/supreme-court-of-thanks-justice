import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { spokenVerdict } from "../src/court/voice.ts";
import { parseCatchphrase } from "../src/shared/cast.ts";
import { STUB_MP3, stubTts } from "../src/shared/stub.ts";
import { login, makeApp } from "./helpers.ts";

const voiceEnv = (extra: Record<string, string> = {}) => ({
  ELEVENLABS_BASE: "https://gateway.example/v1/gateway/custom_api/x",
  ELEVENLABS_VOICE_ID: "judge-voice",
  ELEVENLABS_MODEL_ID: "eleven_flash_v2_5",
  DATA_DIR: mkdtempSync(join(tmpdir(), "fc-voice-")),
  ...extra,
});
const CASE = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  filedBy: "pro_se" as const,
  filings: [{ author: "Sky Sister", kind: "response", body: "I was there first." }],
};
type Made = ReturnType<typeof makeApp>;
const rule = async (m: Made) => {
  const { id, number } = m.ctx.hearings.file(CASE);
  await m.ctx.hearings.start(id);
  return { id, number };
};
const kinds = (m: Made, id: number) => (m.ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);

beforeEach(() => stubTts.reset());

describe("the spoken verdict", () => {
  it("speaks the bench verdict once, through the TTS connector, before the gavel", async () => {
    const env = voiceEnv();
    const m = makeApp(env);
    const { id, number } = await rule(m);

    expect(stubTts.requests).toHaveLength(1);
    const bench = (m.ctx.db.prepare("SELECT bench_verdict FROM rulings WHERE case_id = ?").get(id) as { bench_verdict: string }).bench_verdict;
    // The judge ends with his catchphrase, so the page can bang the gavel right after it.
    const spoken = spokenVerdict(bench, m.ctx.cast.catchphrase);
    expect(stubTts.requests[0]).toEqual({ voice: "judge-voice", text: spoken, model_id: "eleven_flash_v2_5" });
    expect(spoken.endsWith(m.ctx.cast.catchphrase)).toBe(true);
    expect(spoken.length).toBeLessThanOrEqual(300);
    expect(m.ctx.budget.used("tts_chars")).toBe(spoken.length);

    const file = join(env.DATA_DIR, "audio", `case-${number}.mp3`);
    expect(new Uint8Array(readFileSync(file))).toEqual(STUB_MP3);
    expect(kinds(m, id).slice(-2)).toEqual(["voice.ready", "case.closed"]);
  });

  it("never synthesizes the same verdict twice", async () => {
    const m = makeApp(voiceEnv());
    const { number } = await rule(m);
    const again = await m.ctx.voice.speak(number, "anything");
    expect(again).toMatchObject({ status: "ready", cached: true });
    expect(stubTts.requests).toHaveLength(1);
  });

  it("serves the verdict audio behind the court passcode", async () => {
    const m = makeApp(voiceEnv());
    const cookie = await login(m.app);
    const { number } = await rule(m);
    expect((await m.app.request(`/cases/${number}/verdict.mp3`)).status).toBe(401);
    const res = await m.app.request(`/cases/${number}/verdict.mp3`, { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(STUB_MP3);
    const view = await (await m.app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.ruling.voice).toEqual({ status: "ready", url: `/cases/${number}/verdict.mp3` });
  });

  it("when TTS_CHARS_DAILY runs out, the verdict is in writing and the judge has lost their voice", async () => {
    const m = makeApp(voiceEnv({ TTS_CHARS_DAILY: "10" }));
    const cookie = await login(m.app);
    const { id, number } = await rule(m);
    expect(stubTts.requests).toHaveLength(0);
    expect(m.ctx.hearings.getCase(id)!.status).toBe("ruled");
    const ev = m.ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind = 'voice.unavailable'").get(id) as { message: string };
    expect(ev.message).toMatch(/lost their voice for today/);
    const view = await (await m.app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.ruling.voice.status).toBe("no_budget");
    expect(view.ruling.benchVerdict).toBeTruthy();
    expect((await m.app.request(`/cases/${number}/verdict.mp3`, { headers: { cookie } })).status).toBe(404);
  });

  it("a TTS failure never blocks the gavel", async () => {
    stubTts.failNext = 1;
    const m = makeApp(voiceEnv());
    const { id, number } = await rule(m);
    expect(m.ctx.hearings.getCase(id)!.status).toBe("ruled");
    expect(kinds(m, id)).toContain("voice.unavailable");
    expect(m.ctx.voice.hasAudio(number)).toBe(false);
  });

  it("without ELEVENLABS_BASE there is no voice at all (and the official connector is never used)", async () => {
    const env = voiceEnv();
    delete (env as Record<string, string | undefined>).ELEVENLABS_BASE;
    const m = makeApp(env);
    const { id } = await rule(m);
    expect(stubTts.requests).toHaveLength(0);
    expect(kinds(m, id).some((k) => k.startsWith("voice."))).toBe(false);
    expect(existsSync(join(env.DATA_DIR, "audio"))).toBe(false);
  });
});

describe("“The end!!!”: the spoken verdict ends with the judge's catchphrase", () => {
  it("is read from Max's persona", () => {
    expect(parseCatchphrase(readFileSync("content/judge-persona.md", "utf8"))).toBe("The end!!!");
    expect(parseCatchphrase("no catchphrase here")).toBeNull();
  });

  it("is added once, never twice, and the whole thing stays within 300 characters", () => {
    expect(spokenVerdict("The court rules for Max", "The end!!!")).toBe("The court rules for Max. The end!!!");
    expect(spokenVerdict("Max wins! The end!!!", "The end!!!")).toBe("Max wins! The end!!!");
    expect(spokenVerdict("Max wins. The end!", "The end!!!")).toBe("Max wins. The end!");
    const long = spokenVerdict("word ".repeat(80).trim(), "The end!!!");
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith(". The end!!!")).toBe(true);
  });
});
