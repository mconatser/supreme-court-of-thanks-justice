// @vitest-environment jsdom
/**
 * The case page (public/js/case.js) in a real DOM: live updates from the SSE stream must render
 * without leaving the page.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

type Listener = (m: { data: string }) => void;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners: Record<string, Listener[]> = {};
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

const baseCase = (over: Record<string, unknown> = {}) => ({
  number: 1,
  label: "Case #0001",
  title: "Max v. Dad",
  plaintiff: "Max",
  defendant: "Dad",
  type: "petition",
  status: "gathering",
  final: false,
  filings: [{ author: "Max", kind: "complaint", body: "I want to stay up late.", struck: false, contempt: "no" }],
  summons: [],
  ruling: null,
  appeal: { status: null, canAppeal: false, parties: ["Max", "Dad"] },
  mistrial: { offered: false },
  viewer: { isParent: false },
  ...over,
});

let current: ReturnType<typeof baseCase>;
/** Per-request delays (ms) for /api/cases/1, in request order: lets a test answer out of order. */
let delays: number[] = [];
const fetched: string[] = [];
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

function loadPage() {
  const html = readFileSync("public/case.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
  window.history.replaceState({}, "", "/cases/1");
  (globalThis as any).EventSource = FakeEventSource;
  (globalThis as any).fetch = async (url: string) => {
    fetched.push(url);
    const snapshot = current; // what the server says at request time…
    const delay = url.startsWith("/api/cases/1") || url.startsWith("/api/v/") ? (delays.shift() ?? 0) : 0;
    if (delay) await new Promise((r) => setTimeout(r, delay)); // …but it may answer late
    const body = url.startsWith("/api/cases/1") || url.startsWith("/api/v/")
      ? snapshot
      : url.startsWith("/api/docket")
        ? { cast: { court: "The Supreme Court of Thanks-Justice" } }
        : url.startsWith("/healthz")
          ? { ok: true, bootedAt: 1, uptimeMs: 999_999 }
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  // Run the page's scripts in this window, as the browser would.
  // A classic <script> defines its top-level functions as globals even under "use strict"; an
  // indirect eval of strict code doesn't, so drop the directive for common.js's shared helpers.
  (0, eval)(readFileSync("public/js/common.js", "utf8").replace(/^"use strict";/m, ""));
  (0, eval)(readFileSync("public/js/case.js", "utf8"));
}

beforeEach(() => {
  FakeEventSource.last = null;
  delays = [];
  fetched.length = 0;
  delete (window as any).FC_CASE;
  current = baseCase();
});

describe("case page, live from the stream", () => {
  it("shows the summons and the “Tell your side” button as soon as summons.issued arrives", async () => {
    loadPage();
    await settle();
    const es = FakeEventSource.last!;
    expect(es).toBeTruthy();
    expect(document.querySelector("#summons-slot a")).toBeNull();

    // The court issues a summons (emailed, too): the stream says so, the API now lists it.
    current = baseCase({
      status: "awaiting_testimony",
      summons: [{ party: "Dad", status: "pending", via: "email", url: "/summons/abc123" }],
    });
    es.emit("court", { id: 7, ts: Date.now(), actor: "clerk", kind: "summons.issued", message: "The court summons Dad to tell their side." });
    await settle();

    const button = document.querySelector<HTMLAnchorElement>("#summons-slot a.btn");
    expect(button?.getAttribute("href")).toBe("/summons/abc123");
    expect(button?.textContent).toContain("Dad: tell your side");
    expect(document.querySelector("#summons-slot")!.textContent).toMatch(/emailed/);
    expect(document.querySelector("#transcript")!.textContent).toContain("The court summons Dad");
  });

  it("an older refresh that answers late never paints over a newer one (replayed events race)", async () => {
    loadPage();
    await settle();
    const es = FakeEventSource.last!;
    // Replay delivers screening.done and summons.issued back to back. The first refresh is slow…
    delays = [80, 0];
    es.emit("court", { id: 3, ts: Date.now(), actor: "bailiff", kind: "screening.done", message: "The bailiff checks the filings." });
    current = baseCase({ status: "awaiting_testimony", summons: [{ party: "Dad", status: "pending", via: "in_person", url: "/summons/abc123" }] });
    es.emit("court", { id: 7, ts: Date.now(), actor: "clerk", kind: "summons.issued", message: "The court summons Dad to tell their side." });
    await new Promise((r) => setTimeout(r, 150));
    await settle();
    // …and answers last, with the case as it was before the summons. It must not win.
    expect(document.querySelector<HTMLAnchorElement>("#summons-slot a.btn")?.getAttribute("href")).toBe("/summons/abc123");
  });

  it("removes the button when the testimony arrives", async () => {
    current = baseCase({ status: "awaiting_testimony", summons: [{ party: "Dad", status: "pending", via: "in_person", url: "/summons/abc123" }] });
    loadPage();
    await settle();
    expect(document.querySelector("#summons-slot a.btn")).toBeTruthy();
    current = baseCase({ status: "gathering", summons: [{ party: "Dad", status: "answered", via: "in_person", url: null }] });
    FakeEventSource.last!.emit("court", { id: 9, ts: Date.now(), actor: "clerk", kind: "testimony.received", message: "Dad has answered the summons." });
    await settle();
    expect(document.querySelector("#summons-slot a.btn")).toBeNull();
  });
});

describe("case page by token (/v/:token, read-only)", () => {
  it("uses only the token's URLs, never the passcode APIs, and shows no appeal form", async () => {
    (window as any).FC_CASE = { number: 1, caseUrl: "/api/v/tok/case", streamUrl: "/api/v/tok/stream", readOnly: true };
    current = baseCase({
      status: "ruled",
      final: true,
      court: "The Supreme Court of Thanks-Justice",
      appeal: { status: null, canAppeal: true, parties: ["Max", "Dad"] }, // even if it said so
      ruling: { outcome: "plaintiff", winner: "Max", vote: "2–0", confidencePct: 80, seats: [], sentence: null, citedArticles: [], voice: { status: "none" } },
    });
    loadPage();
    await settle();
    expect(fetched.filter((u) => !u.startsWith("/healthz"))).toEqual(["/api/v/tok/case"]);
    expect(FakeEventSource.last!.url).toBe("/api/v/tok/stream?after=0");
    expect(document.querySelector("#appeal-slot")!.children).toHaveLength(0);
    expect(document.querySelector(".bar .back")).toBeNull(); // no "‹ Docket" link
    expect(document.querySelector("[data-court-name]")!.textContent).toBe("The Supreme Court of Thanks-Justice");
    expect(document.querySelector(".ruling-card")!.textContent).toContain("Ruling for Max");
  });
});
