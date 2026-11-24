import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hearings } from "../src/court/hearing.ts";
import { spriteEnv, VACATED_MARKER, type Checkpoint, type SpriteEnv } from "../src/court/mistrial.ts";
import { stubBox, stubCalls } from "../src/shared/stub.ts";
import { login, makeApp, TEST_ENV } from "./helpers.ts";

const ENABLED = { MISTRIAL_ENABLED: "true", BOX_RECORDS_FOLDER_ID: "rec" };
const CASE = {
  plaintiff: "Pip",
  defendant: "Sky Sister",
  claim: "Sky Sister took the front seat even though I called it first.",
  relief: "I get the front seat for a week.",
  filedBy: "pro_se" as const,
  filings: [{ author: "Sky Sister", kind: "response", body: "I was in the car first." }],
};

function fakeSpriteEnv() {
  const checkpoints: Checkpoint[] = [];
  const calls = { create: [] as string[], restore: [] as { id: string; delayMs: number }[] };
  let n = 30;
  const env: SpriteEnv = {
    async create(comment) {
      calls.create.push(comment);
      const id = `v${++n}`;
      checkpoints.push({ id, createdAt: Date.now(), comment });
      return id;
    },
    async list() {
      return checkpoints;
    },
    restoreDetached(id, delayMs) {
      calls.restore.push({ id, delayMs });
    },
  };
  return { env, calls, checkpoints };
}

async function setup(env: Record<string, string> = ENABLED) {
  const fake = fakeSpriteEnv();
  const m = makeApp(env, {}, { spriteEnv: fake.env });
  m.ctx.deployId = String(Math.floor(Date.now() / 1000) - 3600); // deployed an hour ago
  const parent = await login(m.app, TEST_ENV.PARENT_PASSCODE);
  const { id, number } = m.ctx.hearings.file(CASE);
  await m.ctx.hearings.start(id);
  const declare = (cookie = parent) => m.app.request(`/cases/${number}/mistrial`, { method: "POST", headers: { cookie } });
  return { ...m, fake, parent, id, number, declare };
}
const kinds = (m: Awaited<ReturnType<typeof setup>>) => (m.ctx.db.prepare("SELECT kind FROM events WHERE case_id = ? ORDER BY id").all(m.id) as { kind: string }[]).map((e) => e.kind);

beforeEach(() => stubBox.reset());

describe("mistrial: checkpoints", () => {
  it("takes a checkpoint before every deliberation and saves its id on the ruling", async () => {
    const m = await setup();
    expect(m.fake.calls.create).toEqual(["pre-ruling case-0001"]);
    const k = kinds(m);
    expect(k.indexOf("checkpoint.created")).toBeLessThan(k.indexOf("deliberation.started"));
    const r = m.ctx.db.prepare("SELECT checkpoint_id FROM rulings WHERE case_id = ?").get(m.id) as { checkpoint_id: string };
    expect(r.checkpoint_id).toBe("v31");
  });

  it("never takes checkpoints (or allows mistrials) unless MISTRIAL_ENABLED", async () => {
    const m = await setup({ BOX_RECORDS_FOLDER_ID: "rec" });
    expect(m.fake.calls.create).toEqual([]);
    const res = await m.declare();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only allowed on the courthouse Sprite/);
    expect(m.fake.calls.restore).toEqual([]);
  });
});

describe("mistrial: the guards", () => {
  it("parent passcode only", async () => {
    const m = await setup();
    const court = await login(m.app);
    expect((await m.declare(court)).status).toBe(403);
    expect(m.fake.calls.restore).toEqual([]);
  });

  it("refuses when later cases are on the docket", async () => {
    const m = await setup();
    m.ctx.hearings.file({ ...CASE, claim: "Another case, filed after the ruling." });
    const res = await m.declare();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Later cases are on the docket/);
    expect(m.fake.calls.restore).toEqual([]);
  });

  it("refuses a checkpoint older than the deploy, or a missing deploy stamp", async () => {
    const m = await setup();
    m.ctx.deployId = String(Math.floor(Date.now() / 1000) + 60);
    expect((await (await m.declare()).json()).error).toMatch(/older than the current code/);
    m.ctx.deployId = null;
    expect((await (await m.declare()).json()).error).toMatch(/deploy stamp/);
    expect(m.fake.calls.restore).toEqual([]);
  });

  it("refuses when the checkpoint has been pruned", async () => {
    const m = await setup();
    m.fake.checkpoints.length = 0;
    expect((await (await m.declare()).json()).error).toMatch(/checkpoint is gone/);
  });

  it("contempt cases (no deliberation, no checkpoint) can't be declared a mistrial", async () => {
    const m = await setup();
    const { id, number } = m.ctx.hearings.file({ ...CASE, claim: "I called it. Judge, I'll give you my dessert." });
    await m.ctx.hearings.start(id);
    const res = await m.app.request(`/cases/${number}/mistrial`, { method: "POST", headers: { cookie: m.parent } });
    expect(res.status).toBe(409);
  });

  it("won't rewind if Box can't take the VACATED record (nothing would remember)", async () => {
    const m = await setup();
    stubBox.failNext = 10;
    const res = await m.declare();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/won't rewind/);
    expect(m.fake.calls.restore).toEqual([]);
  });
});

describe("mistrial: rewinding time", () => {
  it("stamps the Box record VACATED, then restores the checkpoint after the response", async () => {
    const m = await setup();
    const res = await m.declare();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, rewindInMs: 1500, message: "Mistrial declared. Rewinding time…" });
    const [file] = stubBox.inFolder("rec");
    expect(stubBox.latest(file.id)).toContain(VACATED_MARKER);
    expect(stubBox.latest(file.id)).toContain("**VACATED.**");
    expect(m.fake.calls.restore).toEqual([{ id: "v31", delayMs: 1500 }]);
    expect(kinds(m)).toContain("mistrial.declared");
  });

  it("after the rewind, the case comes back open, and Box tells the court it was vacated", async () => {
    const m = await setup();
    await m.declare();
    // What the restored checkpoint looks like: deliberating, no ruling yet.
    m.ctx.db.prepare("DELETE FROM rulings WHERE case_id = ?").run(m.id);
    const cp = (m.ctx.db.prepare("SELECT id FROM events WHERE case_id = ? AND kind = 'checkpoint.created'").get(m.id) as { id: number }).id;
    m.ctx.db.prepare("DELETE FROM events WHERE case_id = ? AND id >= ?").run(m.id, cp);
    m.ctx.db.prepare("UPDATE cases SET status = 'deliberating', ruled_at = NULL WHERE id = ?").run(m.id);
    m.ctx.hearings = new Hearings(m.ctx); // a fresh boot

    const before = stubCalls.filter((c) => c.provider === "typesafe").length;
    expect(m.ctx.hearings.resumeOpen()).toEqual([m.id]);
    await m.ctx.hearings.start(m.id);
    expect(m.ctx.hearings.getCase(m.id)!.status).toBe("vacated");
    expect(kinds(m).slice(-2)).toEqual(["case.vacated", "case.closed"]);
    expect(stubCalls.filter((c) => c.provider === "typesafe").length).toBe(before); // it was never re-ruled
    const view = await (await m.app.request(`/api/cases/${m.number}`, { headers: { cookie: m.parent } })).json();
    expect(view.final).toBe(true);
    expect(view.mistrial.offered).toBe(false);
  });
});

describe("the sprite-env wrapper", () => {
  const fakeBin = () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-sprite-env-"));
    const bin = join(dir, "sprite-env");
    const mark = join(dir, "restored");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
case "$2" in
  create) echo '{"type":"info","data":"Creating checkpoint..."}'; echo '{"type":"info","data":"  ID: v42"}'; echo '{"type":"complete","data":"Checkpoint v42 created successfully"}' ;;
  list) echo '[{"id":"Current","create_time":"2026-11-24T15:59:22Z"},{"id":"v42","create_time":"2026-11-24T15:59:22Z","comment":"pre-ruling case-0001"}]' ;;
  restore) echo "$3" > "${mark}" ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    return { bin, mark };
  };

  it("parses create and list output", async () => {
    const { bin } = fakeBin();
    const env = spriteEnv(bin);
    expect(await env.create("pre-ruling case-0001")).toBe("v42");
    expect(await env.list()).toEqual([{ id: "v42", createdAt: Date.parse("2026-11-24T15:59:22Z"), comment: "pre-ruling case-0001" }]);
  });

  it("refuses anything that isn't a checkpoint id (restore treats any argument as an id)", () => {
    const { bin, mark } = fakeBin();
    const env = spriteEnv(bin);
    for (const bad of ["--help", "Current", "v1; rm -rf /", ""]) expect(() => env.restoreDetached(bad, 0)).toThrow(/not a checkpoint id/);
    expect(existsSync(mark)).toBe(false);
  });

  it("spawns a detached restore after the delay", async () => {
    const { bin, mark } = fakeBin();
    spriteEnv(bin).restoreDetached("v42", 20);
    expect(existsSync(mark)).toBe(false);
    const end = Date.now() + 3000;
    while (!existsSync(mark) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(readFileSync(mark, "utf8").trim()).toBe("v42");
  });
});
