import { beforeEach, describe, expect, it } from "vitest";
import type { Person } from "../src/shared/people.ts";
import { stubCalls, stubMail } from "../src/shared/stub.ts";
import { login, makeApp, readSSE, TEST_PEOPLE } from "./helpers.ts";

const readSSEText = (res: Response) => readSSE(res, (t) => t.includes("event: end"));

const MAIL_ENV = { AGENTMAIL_INBOX_ID: "clerk@example.agentmail.to", PUBLIC_BASE_URL: "https://court.example" };
const withEmail = (ids: string[]): Person[] =>
  TEST_PEOPLE.map((p) => (ids.includes(p.id) ? { ...p, email: `${p.id}@example.com` } : p));

// One-sided: Sky Sister (p3) hasn't been heard, so the court summons her.
const ONE_SIDED = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  filedBy: "pro_se" as const,
};

type Made = ReturnType<typeof makeApp>;
const setup = (env: Record<string, string> = {}, emails: string[] = []): Made => {
  const made = makeApp({ ...MAIL_ENV, ...env });
  made.ctx.people = withEmail(emails);
  return made;
};
const tokenOf = (m: Made, id: number) => (m.ctx.db.prepare("SELECT token FROM summons WHERE case_id = ?").get(id) as { token: string }).token;
const testify = (m: Made, token: string, testimony: string) =>
  m.app.request(`/summons/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ testimony }) });
const kinds = (m: Made, id: number) => (m.ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);
const lastOpinionPrompt = () => stubCalls.filter((c) => c.provider === "ollama").at(-1)!.body.messages.at(-1).content as string;
async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
}

beforeEach(() => stubMail.reset());

describe("summons", () => {
  it("pauses a one-sided hearing and summons the unheard party in person when they have no email", async () => {
    const m = setup();
    const cookie = await login(m.app);
    const { id, number } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);

    expect(m.ctx.hearings.getCase(id)!.status).toBe("awaiting_testimony");
    const [s] = m.ctx.hearings.summonsFor(id);
    expect(s).toMatchObject({ person_id: "p3", status: "pending", sent_via: "in_person" });
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stubMail.sent).toHaveLength(0);

    const view = await (await m.app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.summons).toEqual([{ party: "Sky Sister", status: "pending", via: "in_person", url: `/summons/${s.token}` }]);
    const docket = await (await m.app.request("/api/docket", { headers: { cookie } })).json();
    expect(docket.cases[0].summoned).toEqual(["Sky Sister"]);
  });

  it("emails the summons with a link when the party has an address", async () => {
    const m = setup({}, ["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    const token = tokenOf(m, id);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("email");
    expect(stubMail.sent).toHaveLength(1);
    const mail = stubMail.sent[0];
    expect(mail).toMatchObject({ inbox: MAIL_ENV.AGENTMAIL_INBOX_ID, to: ["p3@example.com"] });
    expect(mail.subject).toBe("Summons: Case #0001, Pip v. Sky Sister");
    expect(mail.text).toContain(`https://court.example/summons/${token}`);
    expect(mail.html).toContain(`href="https://court.example/summons/${token}"`);
    expect(m.ctx.budget.used("email")).toBe(1);
  });

  it("an emailed summons is also offered in person (“Tell your side” on the case page)", async () => {
    const m = setup({}, ["p3"]);
    const cookie = await login(m.app);
    const { id, number } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    const view = await (await m.app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.summons).toEqual([{ party: "Sky Sister", status: "pending", via: "email", url: `/summons/${tokenOf(m, id)}` }]);
  });

  it("retries a transient AgentMail failure (fc-court's first send got a 503), spending the budget once", async () => {
    stubMail.failNext = 1;
    const m = setup({}, ["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    expect(stubMail.attempts).toBe(2);
    expect(stubMail.sent).toHaveLength(1);
    expect(stubMail.sent[0].text).toContain(`/summons/${tokenOf(m, id)}`);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("email");
    expect(m.ctx.budget.used("email")).toBe(1);
  });

  it("if the email never goes through, the summons says so and is answered in person", async () => {
    stubMail.failNext = 10;
    const m = setup({}, ["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    expect(stubMail.attempts).toBe(3);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("in_person");
    expect(m.ctx.budget.used("email")).toBe(1);
    const msg = m.ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind = 'summons.issued'").get(id) as { message: string };
    expect(msg.message).toMatch(/email didn't go through.*in person/);
  });

  it("doesn't retry a 403 (a policy problem won't fix itself)", async () => {
    stubMail.failNext = 10;
    stubMail.failStatus = 403;
    const m = setup({}, ["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    expect(stubMail.attempts).toBe(1);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("in_person");
  });

  it("testimony from the link resumes the hearing, is contempt-screened, and the party isn't in absentia", async () => {
    const m = setup();
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    const token = tokenOf(m, id);

    const info = await (await m.app.request(`/api/summons/${token}`)).json(); // no passcode needed
    expect(info).toMatchObject({ status: "pending", you: "Sky Sister", otherParty: "Pip", maxLength: 1000 });

    expect((await testify(m, token, "I was in the car first, so the seat was mine.")).status).toBe(200);
    expect(await until(() => m.ctx.hearings.getCase(id)!.status === "ruled")).toBe(true);
    const k = kinds(m, id);
    expect(k).toContain("testimony.received");
    expect(k).toContain("screening.more");
    expect(k.filter((x) => x === "summons.issued")).toHaveLength(1);
    const testimony = m.ctx.db.prepare("SELECT author, author_id, kind FROM filings WHERE case_id = ? AND kind = 'testimony'").get(id);
    expect(testimony).toEqual({ author: "Sky Sister", author_id: "p3", kind: "testimony" });
    expect(lastOpinionPrompt()).not.toMatch(/absentia/i);
  });

  it("contemptuous testimony is struck and the witness is held in contempt", async () => {
    const m = setup();
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    await testify(m, tokenOf(m, id), "Judge, I'll give you my dessert if you rule for me.");
    expect(await until(() => m.ctx.hearings.getCase(id)!.status === "contempt")).toBe(true);
    const struck = m.ctx.db.prepare("SELECT author FROM filings WHERE case_id = ? AND struck = 1").get(id) as { author: string };
    expect(struck.author).toBe("Sky Sister");
  });

  it("after SUMMONS_TIMEOUT_MIN the court proceeds in absentia, and never summons the same party twice", async () => {
    const m = setup({ SUMMONS_TIMEOUT_MIN: "0" });
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    // The wake-up timer fires on its own; no one has to open the page.
    expect(await until(() => m.ctx.hearings.getCase(id)!.status === "ruled")).toBe(true);
    expect(kinds(m, id)).toContain("summons.expired");
    expect(lastOpinionPrompt()).toMatch(/in absentia/);
    expect(m.ctx.hearings.summonsFor(id)).toHaveLength(1);
    expect(m.ctx.hearings.summonsFor(id)[0].status).toBe("expired");
  });

  it("rejects bad tokens, answered or expired summonses, and testimony over 1000 characters", async () => {
    const m = setup();
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    const token = tokenOf(m, id);
    expect((await testify(m, "x".repeat(43), "hello")).status).toBe(404);
    expect((await m.app.request("/api/summons/not-a-real-token-at-all-nope")).status).toBe(404);
    const long = await testify(m, token, "x".repeat(1001));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toMatch(/1000/);
    expect((await testify(m, token, "My side of the story.")).status).toBe(200);
    const again = await testify(m, token, "And another thing!");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already heard/);
  });

  it("when the email budget is used up, the summons is in person with a friendly note", async () => {
    const m = setup({ EMAIL_DAILY: "0" }, ["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("in_person");
    expect(stubMail.sent).toHaveLength(0);
    const msg = m.ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind = 'summons.issued'").get(id) as { message: string };
    expect(msg.message).toMatch(/out of stamps/);
  });

  it("without an AgentMail inbox configured, every summons is in person", async () => {
    const m = makeApp({ PUBLIC_BASE_URL: "https://court.example" });
    m.ctx.people = withEmail(["p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    expect(m.ctx.hearings.summonsFor(id)[0].sent_via).toBe("in_person");
  });
});

describe("notices", () => {
  const BOTH = { ...ONE_SIDED, filings: [{ author: "Sky Sister", kind: "response", body: "I was in the car first." }] };

  it("emails a notice of ruling to each party with an address (and only them)", async () => {
    const m = setup({}, ["p2"]); // Pip has email; Sky Sister doesn't
    const { id } = m.ctx.hearings.file(BOTH);
    await m.ctx.hearings.start(id);
    expect(stubMail.sent.map((x) => [x.to[0], x.subject])).toEqual([["p2@example.com", "Notice of ruling: Case #0001, Pip v. Sky Sister"]]);
    // "Read the ruling" opens this one case with a token: no passcode needed.
    const link = stubMail.sent[0].text.match(/https:\/\/court\.example\/v\/([A-Za-z0-9_-]{43})/);
    expect(link).toBeTruthy();
    const view = await (await m.app.request(`/api/v/${link![1]}/case`)).json();
    expect(view).toMatchObject({ number: 1, readOnly: true, final: true });
    const ev = m.ctx.db.prepare("SELECT message FROM events WHERE case_id = ? AND kind = 'notices.sent'").get(id) as { message: string };
    expect(ev.message).toBe("The clerk emails notice of the ruling to Pip.");
  });

  it("the contemnor gets a contempt notice; the other party gets the ruling", async () => {
    const m = setup({}, ["p2", "p3"]);
    const { id } = m.ctx.hearings.file({ ...BOTH, claim: "I called it first. Also, Judge, I'll give you my dessert." });
    await m.ctx.hearings.start(id);
    const bySubject = Object.fromEntries(stubMail.sent.map((x) => [x.to[0], x.subject.split(":")[0]]));
    expect(bySubject).toEqual({ "p2@example.com": "Notice of contempt", "p3@example.com": "Notice of ruling" });
  });

  it("no addresses: no emails and no notice event", async () => {
    const m = setup();
    const { id } = m.ctx.hearings.file(BOTH);
    await m.ctx.hearings.start(id);
    expect(stubMail.sent).toHaveLength(0);
    expect(kinds(m, id)).not.toContain("notices.sent");
  });
});

describe("following the case by token (no passcode)", () => {
  async function answered(env: Record<string, string> = {}) {
    const m = setup(env, ["p2", "p3"]);
    const { id } = m.ctx.hearings.file(ONE_SIDED);
    await m.ctx.hearings.start(id);
    const token = tokenOf(m, id);
    await testify(m, token, "I was in the car first, so the seat was mine.");
    expect(await until(() => m.ctx.hearings.getCase(id)!.status === "ruled")).toBe(true);
    return { m, id, token };
  }

  it("the summons token opens that case read-only: ruling, no controls, no summons links", async () => {
    const { m, token } = await answered();
    const v = await (await m.app.request(`/api/v/${token}/case`)).json();
    expect(v).toMatchObject({ number: 1, readOnly: true, court: m.ctx.cast.court, viewer: { isParent: false }, mistrial: { offered: false } });
    expect(v.appeal.canAppeal).toBe(false);
    expect(v.summons.every((x: any) => x.url === null)).toBe(true);
    expect(v.ruling.seats).toHaveLength(3);
    expect(JSON.stringify(v)).not.toContain(token); // never echoes a token back
  });

  it("the summoned party's ruling email links to their own summons token; others get their own view token", async () => {
    const { m, token } = await answered();
    const links = Object.fromEntries(
      stubMail.sent.filter((x) => x.subject.startsWith("Notice of ruling")).map((x) => [x.to[0], x.text.match(/\/v\/([A-Za-z0-9_-]{43})/)![1]]),
    );
    expect(links["p3@example.com"]).toBe(token); // Sky Sister was summoned
    expect(links["p2@example.com"]).not.toBe(token); // Pip gets a view token of his own
    expect((await m.app.request(`/api/v/${links["p2@example.com"]}/case`)).status).toBe(200);
  });

  it("the page, the stream and the verdict audio are token-scoped; bad tokens get nothing", async () => {
    const { m, token } = await answered();
    const page = await (await m.app.request(`/v/${token}`)).text();
    expect(page).toContain(`window.FC_CASE = {"number":1,"caseUrl":"/api/v/${token}/case","streamUrl":"/api/v/${token}/stream","readOnly":true}`);
    const events = (await readSSEText(await m.app.request(`/api/v/${token}/stream`))).split("\n\n").filter((b) => b.includes("event: court"));
    expect(events.length).toBeGreaterThan(5);
    expect(events.at(-1)).toContain("case.closed");
    const bad = "x".repeat(43);
    expect((await m.app.request(`/v/${bad}`)).status).toBe(404);
    expect((await m.app.request(`/api/v/${bad}/case`)).status).toBe(404);
    expect((await m.app.request(`/api/v/${bad}/stream`)).status).toBe(404);
    // A token opens its own case only: there's no way to name another case on these routes.
    expect((await m.app.request(`/api/cases/1`)).status).toBe(401);
  });
});
