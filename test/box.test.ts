import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BoxClient } from "../src/court/box.ts";
import { FamilyCodeSource } from "../src/court/familyCode.ts";
import { Gateway } from "../src/shared/gateway.ts";
import { stubBox, stubCalls } from "../src/shared/stub.ts";
import { login, makeApp, makeCtx, TEST_ENV } from "./helpers.ts";

const BOX_CODE = `# The Family Code

## Article 1. Dibs
Calling "dibs" only counts if you are in the same room as the thing.

## Article 7. Front Seat
Whoever is oldest gets the front seat, unless it's someone's birthday.

## Sentencing Guidelines
0. Case closed with a warning
1. Say sorry and mean it
2. Do the other person's chore once
3. No dessert tonight
4. No screens for a day
`;

const BOX_ENV = { BOX_FAMILY_CODE_FILE_ID: "fc1", BOX_RECORDS_FOLDER_ID: "rec" };
const CASE = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  filedBy: "pro_se" as const,
  filings: [{ author: "Sky Sister", kind: "response", body: "I was there first." }],
};
const downloads = (since: number) => stubCalls.slice(since).filter((c) => c.provider === "box" && c.path.endsWith("/content") && c.method === "GET").length;
const box = () => new BoxClient(new Gateway({ mode: "stub", listUrl: "unused", log: () => {} }));

beforeEach(() => {
  stubBox.reset();
  stubBox.put("fc1", "Family Code.md", BOX_CODE);
});

describe("Family Code from Box", () => {
  it("hearings read the Box copy, and the law library says so", async () => {
    const { app, ctx } = makeApp(BOX_ENV);
    const before = stubCalls.length;
    const { id } = ctx.hearings.file(CASE);
    await ctx.hearings.start(id);
    const delib = stubCalls.slice(before).find((c) => c.provider === "typesafe" && c.body.questions.justice_letter)!;
    expect(delib.body.state.family_code).toContain("Article 7. Front Seat");

    const lib = await (await app.request("/law-library", { headers: { "x-court-token": TEST_ENV.COURT_TOKEN } })).json();
    expect(lib.origin.source).toBe("box");
    expect(lib.articles.map((a: any) => a.number)).toEqual([1, 7]);
    expect(lib.sentencing[1]).toBe("Say sorry and mean it");
  });

  it("downloads only when the Box version changes", async () => {
    let t = 0;
    const src = new FamilyCodeSource({ filePath: "content/family-code.md", box: box(), fileId: "fc1", minCheckMs: 1000, now: () => t });
    const before = stubCalls.length;
    await src.refresh();
    t += 5000;
    await src.refresh(); // same version: info check only
    expect(downloads(before)).toBe(1);
    t += 500;
    stubBox.put("fc1", "Family Code.md", BOX_CODE.replace("Dibs", "Dibs (amended)"));
    await src.refresh(); // inside the throttle window: not even an info check
    expect(src.load().articles[0].title).toBe("Dibs");
    t += 5000;
    await src.refresh();
    expect(downloads(before)).toBe(2);
    expect(src.load().articles[0].title).toBe("Dibs (amended)");
  });

  it("if Box is down: last saved copy first, then the local file, with a polite warning", async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), "fc-code-")), "family-code.box.md");
    const first = new FamilyCodeSource({ filePath: "content/family-code.md", cachePath, box: box(), fileId: "fc1" });
    await first.refresh();
    expect(first.where.source).toBe("box");

    stubBox.failNext = 5;
    const afterReboot = new FamilyCodeSource({ filePath: "content/family-code.md", cachePath, box: box(), fileId: "fc1" });
    const code = await afterReboot.refresh();
    expect(afterReboot.where.source).toBe("box-cache");
    expect(code.articles.map((a) => a.number)).toEqual([1, 7]);
    expect(code.warnings.at(-1)).toMatch(/last saved copy/);

    stubBox.failNext = 5;
    const noCache = new FamilyCodeSource({ filePath: "content/family-code.md", box: box(), fileId: "fc1" });
    const local = await noCache.refresh();
    expect(noCache.where.source).toBe("file");
    expect(local.warnings.at(-1)).toMatch(/local copy/);
  });

  it("POST /admin/reload-code is parent-only and re-reads Box", async () => {
    const { app } = makeApp(BOX_ENV);
    const court = await login(app);
    expect((await app.request("/admin/reload-code", { method: "POST", headers: { cookie: court } })).status).toBe(403);
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const res = await (await app.request("/admin/reload-code", { method: "POST", headers: { cookie: parent } })).json();
    expect(res).toMatchObject({ ok: true, source: "box", articles: 2 });
  });
});

describe("court records in Box", () => {
  it("files Case-0001.md (attributes before file) with aliases, votes and the opinion", async () => {
    const ctx = makeCtx(BOX_ENV);
    const { id } = ctx.hearings.file(CASE);
    await ctx.hearings.start(id);

    const files = stubBox.inFolder("rec");
    expect(files.map((f) => f.name)).toEqual(["Case-0001.md"]);
    const md = stubBox.latest(files[0].id)!;
    expect(md).toContain(`# ${ctx.cast.court}: Case #0001`);
    expect(md).toContain("Pip v. Sky Sister");
    expect(md).toContain("### The panel");
    expect(md).toContain(`${ctx.cast.justices.memory}:** recused: no precedent yet`);
    expect(md).toContain("### Opinion of the Court");
    const upload = stubCalls.filter((c) => c.provider === "box" && c.path === "/upload/files/content").at(-1)!;
    expect(Object.keys(upload.form!)[0]).toBe("attributes");

    const r = ctx.db.prepare("SELECT box_file_id FROM rulings WHERE case_id = ?").get(id) as { box_file_id: string };
    expect(r.box_file_id).toBe(files[0].id);
    const kinds = (ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(id) as { kind: string }[]).map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(["record.filed", "case.closed"]);
  });

  it("a name clash (409) becomes a new version of the existing file", async () => {
    stubBox.put("old1", "Case-0001.md", "stale record from a reset database", "rec");
    const ctx = makeCtx(BOX_ENV);
    const { id } = ctx.hearings.file(CASE);
    await ctx.hearings.start(id);
    expect(stubBox.inFolder("rec")).toHaveLength(1);
    expect(stubBox.files.get("old1")!.versions).toHaveLength(2);
    expect(stubBox.latest("old1")).toContain("Case #0001");
  });

  it("a Box outage never blocks the gavel; the record is filed on the next boot", async () => {
    const ctx = makeCtx(BOX_ENV);
    const { id } = ctx.hearings.file(CASE);
    stubBox.failNext = 100;
    await ctx.hearings.start(id);
    expect(ctx.hearings.getCase(id)!.status).toBe("ruled");
    const kinds = (ctx.db.prepare("SELECT kind FROM events WHERE case_id = ?").all(id) as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toContain("record.trouble");
    expect(kinds).toContain("case.closed");

    stubBox.failNext = 0;
    expect(await ctx.hearings.retryRecords()).toBe(1);
    expect(stubBox.inFolder("rec").map((f) => f.name)).toEqual(["Case-0001.md"]);
    expect(await ctx.hearings.retryRecords()).toBe(0);
  });

  it("approving a petition files a new version of the record", async () => {
    const { app, ctx } = makeApp(BOX_ENV);
    const parent = await login(app, TEST_ENV.PARENT_PASSCODE);
    const { id, number } = ctx.hearings.file({
      plaintiff: "Pip",
      defendant: "The Big Cheese",
      claim: "My bedtime should be later on Fridays because there is no school on Saturday.",
      relief: "Bedtime is 9pm on Fridays.",
      filedBy: "pro_se",
      filings: [{ author: "The Big Cheese", kind: "response", body: "Sleep matters." }],
    });
    await ctx.hearings.start(id);
    const [file] = stubBox.inFolder("rec");
    expect(stubBox.latest(file.id)).toContain("awaiting the Executive Branch");

    await app.request(`/cases/${number}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: parent },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(file.versions).toHaveLength(2);
    expect(stubBox.latest(file.id)).toContain("APPROVED by the Executive Branch");
  });

  it("the opinion cites only articles that exist in the Box Family Code", async () => {
    const { app, ctx } = makeApp(BOX_ENV);
    const cookie = await login(app);
    const { id, number } = ctx.hearings.file(CASE);
    await ctx.hearings.start(id);
    const view = await (await app.request(`/api/cases/${number}`, { headers: { cookie } })).json();
    expect(view.ruling.citedArticles).toEqual([{ number: 1, title: "Dibs" }]);
  });
});
