import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server.ts";
import { loadConfig } from "../src/shared/config.ts";
import { TEST_ENV, TEST_PEOPLE } from "./helpers.ts";

const build = (env: Record<string, string>) =>
  buildApp(loadConfig({ ...TEST_ENV, ...env }), env.MODE === "lawyer" ? [] : TEST_PEOPLE, {
    court: { dbPath: ":memory:", log: () => {}, landmarksPath: "test/no-landmarks.md" },
    lawyer: { dbPath: ":memory:", log: () => {} },
  });

describe("MODE (one Sprite or two)", () => {
  it("MODE=court: only the courthouse; /lawyer redirects to the lawyer's Sprite", async () => {
    const { app, court, lawyer } = build({ MODE: "court", LAWYER_URL: "https://fc-lawyer-wc3u.sprites.app/" });
    expect(court).not.toBeNull();
    expect(lawyer).toBeNull();
    for (const [path, to] of [
      ["/lawyer", "https://fc-lawyer-wc3u.sprites.app/lawyer"],
      ["/lawyer/", "https://fc-lawyer-wc3u.sprites.app/lawyer/"],
      ["/lawyer/api/state", "https://fc-lawyer-wc3u.sprites.app/lawyer/api/state"],
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location")).toBe(to);
    }
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("MODE=court without LAWYER_URL: no lawyer routes at all", async () => {
    const { app } = build({ MODE: "court" });
    expect((await app.request("/lawyer/api/state")).status).toBe(404);
  });

  it("MODE=all still serves the lawyer here", async () => {
    const { app, lawyer } = build({ MODE: "all", LAWYER_CLIENT: "Pip" });
    expect(lawyer).not.toBeNull();
    expect((await app.request("/lawyer/api/state")).status).toBe(401); // there, behind the lawyer passcode
  });

  it("MODE=lawyer: counsel only, with its own login", async () => {
    const { app, court } = build({ MODE: "lawyer", LAWYER_CLIENT: "Pip", COURT_PASSCODE: "", PARENT_PASSCODE: "" });
    expect(court).toBeNull();
    expect((await app.request("/")).headers.get("location")).toBe("/lawyer");
    const login = await app.request("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: TEST_ENV.LAWYER_PASSCODE }) });
    expect(login.status).toBe(200);
  });
});
