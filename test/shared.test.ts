import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/court/db.ts";
import { RateLimiter, rolesForPasscode } from "../src/shared/auth.ts";
import { Budget, RecessError } from "../src/shared/budget.ts";
import { loadConfig } from "../src/shared/config.ts";
import { Gateway, GatewayError, parseGatewayList } from "../src/shared/gateway.ts";
import { parsePeople } from "../src/shared/people.ts";
import { TEST_ENV } from "./helpers.ts";

describe("gateway discovery", () => {
  const list = JSON.parse(readFileSync("fixtures/gateway/list.json", "utf8"));

  it("collects every object with gateway_base_url, keyed by slug, ignoring 'available'", () => {
    const m = parseGatewayList(list);
    expect([...m.keys()].sort()).toEqual(["ollama", "typesafe"]);
    expect(m.get("typesafe")!.base).toBe("https://api.sprites.dev/v1/gateway/typesafe/conn_typesafe_example");
  });

  it("finds connectors in any nesting", () => {
    const m = parseGatewayList({ deep: [{ x: { gateway_base_url: "https://api.sprites.dev/v1/gateway/box/abc/" } }] });
    expect(m.get("box")!.base).toBe("https://api.sprites.dev/v1/gateway/box/abc");
  });

  it("env overrides beat discovery, and gw() never sends Authorization", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const gw = new Gateway({
      mode: "live",
      listUrl: "https://example.invalid/list",
      overrides: { ollama: "https://override.example/v1/gateway/ollama/x/" },
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return Response.json({ ok: true });
      },
      log: () => {},
    });
    await gw.gw("ollama", "/api/tags", { headers: { authorization: "Bearer nope" } });
    expect(seen).toEqual([{ url: "https://override.example/v1/gateway/ollama/x/api/tags", auth: null }]);
  });

  it("maps 403 to a friendly GatewayError", async () => {
    const gw = new Gateway({
      mode: "live",
      listUrl: "https://example.invalid/list",
      overrides: { box: "https://gw.example/box/x" },
      fetchImpl: async () => new Response("denied", { status: 403 }),
      log: () => {},
    });
    await expect(gw.gw("box", "/2.0/users/me")).rejects.toThrow(GatewayError);
    await expect(gw.gw("box", "/2.0/users/me")).rejects.toThrow(/access policy/);
  });

  it("stub mode serves fixtures without any network", async () => {
    const gw = new Gateway({ mode: "stub", listUrl: "unused", log: () => {} });
    const res = await gw.gw("ollama", "/api/tags");
    expect((await res.json()).models[0].name).toBe("glm-5.3-flash");
    expect((await gw.gw("box", "/2.0/users/me")).status).toBe(404);
  });
});

describe("budget", () => {
  it("spends atomically and refuses past the daily limit", () => {
    const db = openDb(":memory:");
    const b = new Budget(db, { jev: 3, ollama: 1, tts_chars: 300, email: 0 }, "America/New_York");
    b.spend("jev", 2);
    expect(b.remaining("jev")).toBe(1);
    expect(() => b.spend("jev", 2)).toThrow(RecessError);
    expect(b.remaining("jev")).toBe(1); // a refused spend costs nothing
    b.spend("jev");
    expect(b.inSession()).toBe(false);
    expect(b.exhausted()).toContain("jev");
  });

  it("resets each day in the court's time zone", () => {
    const db = openDb(":memory:");
    let now = new Date("2026-11-24T04:30:00Z"); // 11:30pm Monday in New York
    const b = new Budget(db, { jev: 1, ollama: 1, tts_chars: 1, email: 1 }, "America/New_York", () => now);
    b.spend("jev");
    expect(b.inSession()).toBe(false);
    now = new Date("2026-11-24T05:30:00Z"); // 12:30am Tuesday
    expect(b.remaining("jev")).toBe(1);
  });

  it("JEV_DAILY=1 can't cover a hearing, so the court is in recess", () => {
    const b = new Budget(openDb(":memory:"), { jev: 1, ollama: 150, tts_chars: 3000, email: 40 }, "UTC");
    expect(b.inSession()).toBe(false);
  });
});

describe("auth", () => {
  const cfg = loadConfig(TEST_ENV);

  it("maps passcodes to roles; the parent passcode also opens the court", () => {
    expect(rolesForPasscode(cfg, "court-pass")).toEqual(["court"]);
    expect(rolesForPasscode(cfg, " parent-pass ")).toEqual(["parent", "court"]);
    expect(rolesForPasscode(cfg, "lawyer-pass")).toEqual(["lawyer"]);
    expect(rolesForPasscode(cfg, "nope")).toEqual([]);
    expect(rolesForPasscode(cfg, "")).toEqual([]);
  });

  it("rate limits within the window", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.take("ip")).toBe(true);
    expect(rl.take("ip")).toBe(true);
    expect(rl.take("ip")).toBe(false);
    expect(rl.take("other")).toBe(true);
    t = 1001;
    expect(rl.take("ip")).toBe(true);
  });
});

describe("config and people", () => {
  it("fails with a friendly message when secrets are missing", () => {
    expect(() => loadConfig({ GATEWAY_MODE: "stub" })).toThrow(/can't open yet[\s\S]*COURT_TOKEN/);
  });

  it("treats empty .env values as unset", () => {
    const cfg = loadConfig({ ...TEST_ENV, JEV_DAILY: "", TYPESAFE_BASE: "" });
    expect(cfg.JEV_DAILY).toBe(300);
    expect(cfg.TYPESAFE_BASE).toBeUndefined();
  });

  it("requires a non-empty alias for every person", () => {
    expect(() =>
      parsePeople([
        { id: "a", alias: "Pip", role: "kid" },
        { id: "b", alias: "  ", role: "parent" },
        { id: "c", role: "kid" },
      ]),
    ).toThrow(/needs a court alias[\s\S]*Add an "alias" for: entry 2, entry 3/);
  });

  it("rejects duplicate aliases and bad roles", () => {
    expect(() => parsePeople([{ id: "a", alias: "Pip", role: "kid" }, { id: "b", alias: "pip", role: "kid" }])).toThrow(/same alias/);
    expect(() => parsePeople([{ id: "a", alias: "Pip", role: "boss" }])).toThrow(/doesn't look right/);
  });
});

describe("ollama structured output", () => {
  it("accepts JSON wrapped in ```json fences (glm-5.3-flash does this)", async () => {
    const { parseJsonReply } = await import("../src/shared/ollama.ts");
    expect(parseJsonReply('```json\n{ "a": 1 }\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('{"a": 2}')).toEqual({ a: 2 });
    expect(parseJsonReply('Here you go:\n{"a": 3}\nEnjoy!')).toEqual({ a: 3 });
    expect(() => parseJsonReply("no json here")).toThrow(/didn't return JSON/);
  });
});
