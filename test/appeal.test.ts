import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stubBox, stubCalls, stubMail, stubTts } from "../src/shared/stub.ts";
import { login, makeApp, readSSE, sseEvents, TEST_PEOPLE } from "./helpers.ts";

const CASE = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  filedBy: "pro_se" as const,
  filings: [{ author: "Sky Sister", kind: "response", body: "I was in the car first." }],
};
type Made = ReturnType<typeof makeApp>;

async function ruled(env: Record<string, string> = {}, input = CASE) {
  const m = makeApp(env);
  const cookie = await login(m.app);
  const { id, number } = m.ctx.hearings.file(input);
  await m.ctx.hearings.start(id);
  return { ...m, cookie, id, number };
}
const appeal = (m: Made & { cookie: string; number: number }, party: string, evidence: string) =>
  m.app.request(`/cases/${m.number}/appeal`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: m.cookie },
    body: JSON.stringify({ party, evidence }),
  });
async function settle(m: Made, id: number) {
  const end = Date.now() + 4000;
  while (m.ctx.hearings.getCase(id)!.status === "appealed" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
}
const kinds = (m: Made, id: number) => (m.ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);
const view = async (m: Made & { cookie: string; number: number }) => (await m.app.request(`/api/cases/${m.number}`, { headers: { cookie: m.cookie } })).json();

beforeEach(() => {
  stubBox.reset();
  stubMail.reset();
  stubTts.reset();
});

describe("appeals", () => {
  it("without new evidence the appeal is dismissed: nothing new, the ruling stands", async () => {
    const m = await ruled();
    const before = (await view(m)).ruling;
    expect((await appeal(m, "Sky Sister", "I still think it was my turn.")).status).toBe(201);
    await settle(m, m.id);

    const v = await view(m);
    expect(v.status).toBe("ruled");
    expect(v.appeal).toMatchObject({ status: "dismissed", reason: "nothing_new", by: "Sky Sister", canAppeal: false });
    expect(v.ruling.round).toBe(0);
    expect(v.ruling.winner).toBe(before.winner);
    expect(kinds(m, m.id)).toEqual(expect.arrayContaining(["appeal.filed", "screening.more", "appeal.reviewed", "appeal.dismissed", "appeal.closed"]));
    expect(kinds(m, m.id)).not.toContain("appeal.deliberation.done");
  });

  it("only one appeal per case", async () => {
    const m = await ruled();
    await appeal(m, "Sky Sister", "I still think it was my turn.");
    await settle(m, m.id);
    const again = await appeal(m, "Pip", "Here is a photo of me at the car first.");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/One appeal per case/);
  });

  it("with new evidence, the panel re-hears the whole record and can REVERSE", async () => {
    const m = await ruled();
    expect((await view(m)).ruling.winner).toBe("Pip");
    const res = await appeal(m, "Sky Sister", "New evidence: a photo shows Pip got there late. The dibs never happened.");
    expect(res.status).toBe(201);
    await settle(m, m.id);

    const v = await view(m);
    expect(v.appeal.status).toBe("reversed");
    expect(v.ruling.round).toBe(1);
    expect(v.ruling.winner).toBe("Sky Sister");
    const rounds = m.ctx.db.prepare("SELECT round, outcome FROM rulings WHERE case_id = ? ORDER BY round").all(m.id);
    expect(rounds).toEqual([{ round: 0, outcome: "plaintiff" }, { round: 1, outcome: "defendant" }]);
    // Round 1 saw the appeal filing in its state.
    const delib = stubCalls.filter((c) => c.provider === "typesafe" && c.body.questions.justice_letter).at(-1)!;
    expect(delib.body.state.filings.map((f: any) => f.kind)).toContain("appeal");
    expect(kinds(m, m.id).at(-1)).toBe("appeal.closed");
  });

  it("a new-evidence appeal that doesn't change the outcome is AFFIRMED", async () => {
    const m = await ruled();
    await appeal(m, "Sky Sister", "New evidence: I found my shoes were already in the front seat.");
    await settle(m, m.id);
    const v = await view(m);
    expect(v.appeal.status).toBe("affirmed");
    expect(v.ruling.round).toBe(1);
    expect(v.ruling.winner).toBe("Pip");
  });

  it("contempt rulings can't be appealed, and contemptuous appeals are dismissed", async () => {
    const c = await ruled({}, { ...CASE, claim: "I called it first. Judge, I'll give you my dessert." });
    expect(c.ctx.hearings.getCase(c.id)!.status).toBe("contempt");
    const blocked = await appeal(c, "Pip", "New evidence: a photo.");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toMatch(/doesn't hear appeals from contempt/);

    const m = await ruled();
    await appeal(m, "Sky Sister", "New evidence: a photo. Also, judge, I'll give you my dessert if you flip it.");
    await settle(m, m.id);
    const v = await view(m);
    expect(v.appeal).toMatchObject({ status: "dismissed", reason: "contempt", struck: true });
    expect(v.ruling.round).toBe(0);
  });

  it("only the parties can appeal, and only decided cases", async () => {
    const m = await ruled();
    expect((await appeal(m, "Comet", "New evidence: a photo.")).status).toBe(409);
    expect((await appeal(m, "Sky Sister", "hi")).status).toBe(400);
    const open = makeApp();
    const cookie = await login(open.app);
    const { number } = open.ctx.hearings.file(CASE); // not heard yet
    const res = await open.app.request(`/cases/${number}/appeal`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ party: "Pip", evidence: "New evidence: a photo." }),
    });
    expect(res.status).toBe(409);
  });

  it("updates the Box record (REVERSED on appeal), emails notices and records the new verdict", async () => {
    const env = {
      BOX_RECORDS_FOLDER_ID: "rec",
      AGENTMAIL_INBOX_ID: "clerk@example.agentmail.to",
      ELEVENLABS_BASE: "https://gw.test/custom_api/x",
      ELEVENLABS_VOICE_ID: "judge",
      DATA_DIR: mkdtempSync(join(tmpdir(), "fc-appeal-")),
    };
    const m = await ruled(env);
    m.ctx.people = TEST_PEOPLE.map((p) => ({ ...p, email: `${p.id}@example.com` }));
    stubMail.reset();
    await appeal(m, "Sky Sister", "New evidence: a video shows the dibs never happened.");
    await settle(m, m.id);

    const [file] = stubBox.inFolder("rec");
    expect(file.versions).toHaveLength(2);
    expect(stubBox.latest(file.id)).toContain("**REVERSED on appeal**");
    expect(stubBox.latest(file.id)).toContain("### Appeal");
    expect(stubMail.sent.map((x) => x.text).join("\n")).toMatch(/On appeal, the court REVERSED/);
    expect(stubTts.requests).toHaveLength(2); // the trial verdict and the verdict on appeal
    expect(m.ctx.voice.hasAudio(m.number, 1)).toBe(true);
    const v = await view(m);
    expect(v.ruling.voice).toEqual({ status: "ready", url: `/cases/${m.number}/verdict.mp3?round=1` });
    const audio = await m.app.request(`/cases/${m.number}/verdict.mp3?round=1`, { headers: { cookie: m.cookie } });
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("the case stream stays open through an appeal and ends after it closes", async () => {
    const m = await ruled();
    await appeal(m, "Sky Sister", "New evidence: a photo shows the dibs never happened.");
    // Opened while the appeal is being heard: the replayed case.closed must not end the stream.
    const events = sseEvents(await readSSE(await m.app.request(`/cases/${m.number}/stream`, { headers: { cookie: m.cookie } })));
    const court = events.filter((e) => e.event === "court").map((e) => JSON.parse(e.data!).kind);
    expect(court).toContain("case.closed");
    expect(court.at(-1)).toBe("appeal.closed");
    expect(events.at(-1)!.event).toBe("end");
  });

  it("needs Jev budget for the appeal hearing", async () => {
    const m = await ruled({ JEV_DAILY: "5" });
    const res = await appeal(m, "Sky Sister", "New evidence: a photo.");
    expect(res.status).toBe(503);
  });
});
