/**
 * Privacy guard. Nothing the family sees may show a person's id, real name or email address, or
 * the judge's old name ("Andrew": he's Judge Andy Gravy). The flows below run with marker people
 * whose ids, names and emails are unmistakable, then every page, API response, stream, email, Box
 * record, spoken verdict, lawyer note and log line is checked for them.
 *
 * When the real people.json is present (it's gitignored), the second part also checks that no real
 * name, family email or name-like id is written into the files that make up the pages.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createCourtApp } from "../src/court/app.ts";
import { createLawyer, createLawyerApp } from "../src/lawyer/app.ts";
import { loadConfig } from "../src/shared/config.ts";
import { Gateway } from "../src/shared/gateway.ts";
import { createOllama, type Ollama } from "../src/shared/ollama.ts";
import { Budget } from "../src/shared/budget.ts";
import { openLawyerDb } from "../src/lawyer/db.ts";
import { stubBox, stubMail, stubTts } from "../src/shared/stub.ts";
import { login, makeApp, readSSE, TEST_ENV } from "./helpers.ts";

// Marker people: same aliases as the fixtures, but ids, names and emails nobody could mistake.
const MARKER_PEOPLE = [
  { id: "zqidcheese", name: "Zqname Cheeseparent", alias: "The Big Cheese", email: "zqmail.cheese@example.com", role: "parent" as const },
  { id: "zqidpip", name: "Zqname Pipkid", alias: "Pip", email: "zqmail.pip@example.com", role: "kid" as const },
  { id: "zqidsky", name: "Zqname Skykid", alias: "Sky Sister", email: "zqmail.sky@example.com", role: "kid" as const },
  { id: "zqidcomet", name: "Zqname Cometkid", alias: "Comet", email: "", role: "kid" as const },
];
const FORBIDDEN = [...new Set(MARKER_PEOPLE.flatMap((p) => [p.id, p.name, ...p.name.split(" "), p.email].filter(Boolean))), "Andrew"];

function leaks(text: string): string[] {
  const low = text.toLowerCase();
  return FORBIDDEN.filter((f) => low.includes(f.toLowerCase()));
}

const until = async (check: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
  stubBox.reset();
  stubMail.reset();
  stubTts.reset();
});

describe("no id, real name, email or “Andrew” on anything the family sees", () => {
  it("court: pages, APIs, streams, summons, token views, emails, Box records, spoken verdicts, logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-privacy-"));
    const logs: string[] = [];
    const peopleFile = join(dir, "people.json");
    writeFileSync(peopleFile, JSON.stringify(MARKER_PEOPLE));
    const { app, ctx } = makeApp(
      {
        BOX_RECORDS_FOLDER_ID: "rec",
        AGENTMAIL_INBOX_ID: "clerk@example.agentmail.to",
        PUBLIC_BASE_URL: "https://court.example",
        ELEVENLABS_BASE: "https://gw.test/custom_api/x",
        ELEVENLABS_VOICE_ID: "judge",
        DATA_DIR: dir,
        PEOPLE_FILE: peopleFile,
      },
      {},
      { log: (m) => logs.push(m) },
    );
    ctx.people = MARKER_PEOPLE.map((p) => ({ ...p }));
    const seen: string[] = [];
    const take = async (res: Response | Promise<Response>) => {
      const text = await (await res).text();
      seen.push(text);
      return text;
    };
    const court = await login(app);
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const post = (path: string, body: unknown, cookie = court) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

    // A two-sided case, a one-sided one (summons by email), and a petition.
    const a = JSON.parse(await take(post("/file", { plaintiff: "Pip", defendant: "Sky Sister", claim: "Sky Sister took my seat on the couch.", relief: "My seat back.", response: "I was sitting there first." })));
    const b = JSON.parse(await take(post("/file", { plaintiff: "Pip", defendant: "The Big Cheese", claim: "Dad took the last cookie without offering it.", relief: "A cookie for me." })));
    const p = JSON.parse(await take(post("/file", { plaintiff: "Pip", defendant: "The Big Cheese", claim: "My bedtime should be later on Fridays.", relief: "Bedtime 9pm Fridays.", response: "Sleep matters." })));
    await until(() => [a, p].every((x) => ["ruled", "too_close", "contempt"].includes(ctx.hearings.getCaseByNumber(x.number)!.status)));
    await until(() => ctx.hearings.getCaseByNumber(b.number)!.status === "awaiting_testimony");

    const token = (ctx.db.prepare("SELECT token FROM summons LIMIT 1").get() as { token: string }).token;
    await take(app.request(`/api/summons/${token}`));
    await take(app.request(`/summons/${token}`));
    await take(post(`/summons/${token}`, { testimony: "I offered it to everyone first." }));
    await until(() => ["ruled", "too_close"].includes(ctx.hearings.getCaseByNumber(b.number)!.status));
    await take(post(`/cases/${a.number}/appeal`, { party: "Sky Sister", evidence: "New evidence: a photo shows I was there first." }));
    await until(() => ctx.hearings.getCaseByNumber(a.number)!.status !== "appealed");
    if (ctx.hearings.getCaseByNumber(p.number)!.approval === "pending") await take(post(`/cases/${p.number}/approval`, { decision: "approve" }, parent));

    for (const path of ["/", "/file", "/api/docket", ...[a, b, p].flatMap((x) => [`/cases/${x.number}`, `/api/cases/${x.number}`])]) {
      await take(app.request(path, { headers: { cookie: parent, accept: path.startsWith("/api") ? "application/json" : "text/html" } }));
    }
    for (const x of [a, b, p]) seen.push(await readSSE(await app.request(`/cases/${x.number}/stream`, { headers: { cookie: court } }), (t) => t.includes("event: end")));
    await take(app.request(`/v/${token}`));
    await take(app.request(`/api/v/${token}/case`));
    seen.push(await readSSE(await app.request(`/api/v/${token}/stream`), (t) => t.includes("event: end")));
    await take(app.request("/law-library", { headers: { "x-court-token": TEST_ENV.COURT_TOKEN } }));
    await take(app.request("/api/parties", { headers: { "x-court-token": TEST_ENV.COURT_TOKEN } }));
    await take(app.request("/api/precedent?q=cookie", { headers: { "x-court-token": TEST_ENV.COURT_TOKEN } }));

    // A broken people.json: the error a parent sees names entries, not ids.
    writeFileSync(peopleFile, JSON.stringify([{ ...MARKER_PEOPLE[1], alias: "" }, MARKER_PEOPLE[1]]));
    await take(post("/admin/reload-people", {}, parent));

    seen.push(...stubMail.sent.flatMap((m) => [m.subject, m.text, m.html ?? ""]));
    seen.push(...[...stubBox.files.values()].flatMap((f) => [f.name, ...f.versions]));
    seen.push(...stubTts.requests.map((r) => r.text));
    seen.push(...logs);

    expect(stubMail.sent.length).toBeGreaterThan(0); // the checks above really saw emails…
    expect(stubBox.inFolder("rec").length).toBeGreaterThan(0); // …records…
    expect(stubTts.requests.length).toBeGreaterThan(0); // …and spoken verdicts
    const all = seen.join("\n");
    expect(all).toContain("Pip"); // aliases are what shows
    expect(leaks(all)).toEqual([]);
  });

  it("lawyer: chat, notes, mock trial, lessons and the ex parte page", async () => {
    const court = makeApp();
    court.ctx.people = MARKER_PEOPLE.map((p) => ({ ...p }));
    const courtApp = createCourtApp(court.ctx);
    const steps = [
      { tools: [{ name: "list_parties", args: {} }, { name: "read_family_code", args: {} }] },
      { tools: [{ name: "mock_trial", args: { defendant: "Sky Sister", title: "Couch", claim: "Sky Sister took my seat on the couch.", relief: "My seat back.", drafts: ["I was there first."], opposing_view: "x" } }] },
      { tools: [{ name: "ask_client", args: { question: "Ready?", confirm_filing: { defendant: "Sky Sister", title: "Couch", claim: "Sky Sister took my seat on the couch.", relief: "My seat back.", argument: "I was there first." } } }] },
    ];
    const stub = createOllama({ gateway: new Gateway({ mode: "stub", listUrl: "x", log: () => {} }), budget: new Budget(openLawyerDb(":memory:"), { jev: 0, ollama: 1000, tts_chars: 0, email: 0 }, "UTC"), model: "m" });
    const ollama: Ollama = {
      async chat() {
        const s = steps.shift() ?? { content: "Done, boss." };
        return { content: (s as any).content ?? "", tool_calls: ((s as any).tools ?? []).map((t: any) => ({ function: { name: t.name, arguments: t.args } })) };
      },
      chatJson: (schema, o) => stub.chatJson(schema, o),
    };
    const cfg = loadConfig({ ...TEST_ENV, LAWYER_CLIENT: "Pip", COURT_URL: "http://court.test" });
    const logs: string[] = [];
    const { lawyer, ctx } = createLawyer(cfg, { dbPath: ":memory:", ollama, courtFetch: (u, i) => Promise.resolve(courtApp.request(u, i)), log: (m) => logs.push(m) });
    const root = new Hono();
    root.route("/lawyer", createLawyerApp(lawyer, ctx));
    root.route("/", courtApp);
    const ref = lawyer.currentMatter();
    await lawyer.handle(ref, { text: "Sky Sister took my seat." });
    steps.push({ tools: [{ name: "file_case", args: { defendant: "Sky Sister", title: "Couch", claim: "Sky Sister took my seat on the couch.", relief: "My seat back.", argument: "I was there first." } }] } as any, { tools: [{ name: "watch_hearing", args: { number: 1 } }] } as any);
    await lawyer.handle(ref, { confirm: true });
    await until(() => !lawyer.isFollowing(1));
    const cookie = await login(root as any, TEST_ENV.LAWYER_PASSCODE);
    const seen = [
      await (await root.request("/lawyer/api/state", { headers: { cookie } })).text(),
      await (await root.request("/lawyer", { headers: { cookie, accept: "text/html" } })).text(),
      JSON.stringify(ctx.db.prepare("SELECT * FROM steps").all()),
      JSON.stringify(ctx.db.prepare("SELECT * FROM lessons").all()),
      ...logs,
    ].join("\n");
    expect(seen).toContain("Pip");
    expect(leaks(seen)).toEqual([]);
  });
});

// ---------- the real people.json (gitignored), when it's here ----------

const realPeople = existsSync("people.json") ? (JSON.parse(readFileSync("people.json", "utf8")) as { id: string; name?: string; alias: string; email?: string }[]) : null;

describe.skipIf(!realPeople)("no real name, family email or name-like id in the files that make up the pages", () => {
  it("content/, public/ and src/ (people.json is read at test time; nothing private is written here)", () => {
    const generic = new Set(["dad", "mom", "gma", "gpa", "grandma", "grandpa", "mother", "father"]);
    const allow = existsSync(".private-terms")
      ? readFileSync(".private-terms", "utf8").split("\n").filter((l) => l.toLowerCase().startsWith("allow:")).map((l) => l.slice(6).trim().toLowerCase())
      : [];
    const allowedTokens = new Set(allow.flatMap((a) => [a, ...a.split(/\s+/)]));
    const terms = new Set<string>();
    for (const p of realPeople!) {
      const name = (p.name ?? "").trim();
      if (name && !generic.has(name.toLowerCase())) for (const t of [name, ...name.split(/\s+/)]) if (t.length >= 3 && !allowedTokens.has(t.toLowerCase())) terms.add(t);
      if (p.email) terms.add(p.email);
      if (p.id && !generic.has(p.id.toLowerCase()) && p.id.toLowerCase() !== p.alias.toLowerCase()) terms.add(p.id);
    }
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const path = join(d, f);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(md|json|ts|js|html|css)$/.test(f)) files.push(path);
      }
    };
    ["content", "public", "src"].forEach(walk);
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const t of terms) {
        if (new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text)) found.push(`${f} (a private term)`);
      }
    }
    expect(found).toEqual([]); // never prints the term itself
  });
});
