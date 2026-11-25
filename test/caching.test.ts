/** After a deploy, open browsers must get the new scripts: nothing is cached without revalidating. */
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/shared/config.ts";
import { login, TEST_ENV, TEST_PEOPLE } from "./helpers.ts";

const app = (MODE: string) =>
  buildApp(loadConfig({ ...TEST_ENV, MODE, COURT_URL: "http://court.test", LAWYER_CLIENT: "Pip" }), TEST_PEOPLE, {
    court: { dbPath: ":memory:", log: () => {} },
    lawyer: { dbPath: ":memory:", log: () => {} },
  }).app;

describe("Cache-Control: a deploy always reaches open browsers", () => {
  for (const mode of ["all", "court", "lawyer"]) {
    it(`MODE=${mode}: scripts, styles and pages say no-cache; unchanged files revalidate with a 304`, async () => {
      const a = app(mode);
      for (const path of ["/js/case.js", "/js/summons.js", "/js/lawyer.js", "/css/court.css", "/css/ruling-card.css", "/sfx/gavel.mp3", "/login"]) {
        const res = await a.request(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("cache-control"), path).toBe("no-cache");
        if (path.startsWith("/login")) continue;
        const tag = res.headers.get("etag");
        expect(tag, path).toBeTruthy();
        const again = await a.request(path, { headers: { "if-none-match": tag! } });
        expect(again.status, path).toBe(304);
      }
    });
  }

  it("the case page, the summons page, /v/ and the API too; the SSE stream keeps its own policy", async () => {
    const a = app("court");
    const cookie = await login(a as any);
    for (const path of ["/", "/cases/1", "/file", "/api/docket"]) {
      expect((await a.request(path, { headers: { cookie } })).headers.get("cache-control"), path).toBe("no-cache");
    }
    expect((await a.request("/summons/abcdefghijklmnopqrstuvwxyz")).headers.get("cache-control")).toBe("no-cache");
    const lawyer = app("lawyer");
    const lcookie = await login(lawyer as any, TEST_ENV.LAWYER_PASSCODE);
    expect((await lawyer.request("/lawyer", { headers: { cookie: lcookie } })).headers.get("cache-control")).toBe("no-cache");
  });
});
