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
    expect(button?.getAttribute("href")).toBe("/summons/abc123?back=case");
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
    expect(document.querySelector<HTMLAnchorElement>("#summons-slot a.btn")?.getAttribute("href")).toBe("/summons/abc123?back=case");
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

describe("Max's ruling card", () => {
  const seat = (key: string, side: string, party: string, pct = 80) => ({ key, name: key, status: "voted", side, party, pct, cites: [] });
  const recused = (key: string) => ({ key, name: key, status: "recused", reason: "recused: no precedent yet" });
  const ruled = (over: Record<string, unknown>) =>
    baseCase({ status: "ruled", final: true, ruling: { sentence: null, citedArticles: [], voice: { status: "none" }, confidencePct: 86, ...over } });
  const render = async (c: ReturnType<typeof baseCase>) => {
    current = c;
    loadPage();
    await settle();
    return document.querySelector(".ruling-card")!;
  };
  const score = (card: Element) => [...card.querySelectorAll(".rc-score > span")].map((x) => x.textContent).join(" ");

  it("a 3–0 win for the defendant reads “Max 0–3 Chozyn”, with no “Ruling for / Vote” block", async () => {
    const card = await render({
      ...ruled({ outcome: "defendant", winner: "Chozyn", vote: "3–0", seats: [seat("justice_letter", "defendant", "Chozyn"), seat("justice_heart", "defendant", "Chozyn"), seat("justice_memory", "defendant", "Chozyn")] }),
      plaintiff: "Max",
      defendant: "Chozyn",
    });
    expect(card.querySelector(".rc-head .rc-case")!.textContent).toBe("Case #0001");
    expect(score(card)).toBe("Max 0–3 Chozyn");
    // Between the justices' votes and the "How sure the court is" bar.
    const order = [...card.children].map((x) => x.className);
    expect(order.indexOf("rc-head")).toBe(order.indexOf("rc-seats") + 1);
    expect(order.indexOf("rc-meter")).toBeGreaterThan(order.indexOf("rc-head"));
    expect(card.firstElementChild!.className).toBe("rc-seats");
    expect(card.querySelector(".rc-score .won")!.textContent).toBe("Chozyn");
    expect(card.textContent).not.toMatch(/Ruling for|Vote 3–0/);
    expect(card.querySelector(".rc-title")).toBeNull();
  });

  it("splits, compromises and recusals: “Max 1–1 Hailey”, “Hailey 2–0 Dad”", async () => {
    const split = await render({
      ...ruled({ outcome: "compromise", vote: "1–1", split: true, confidencePct: null, seats: [seat("justice_letter", "plaintiff", "Max"), seat("justice_heart", "defendant", "Hailey"), recused("justice_memory")] }),
      plaintiff: "Max",
      defendant: "Hailey",
    });
    expect(score(split)).toBe("Max 1–1 Hailey");
    expect(split.querySelector(".rc-outcome")!.textContent).toMatch(/compromise/);
    const recusal = await render({
      ...ruled({ outcome: "plaintiff", winner: "Hailey", vote: "2–0", seats: [seat("justice_letter", "plaintiff", "Hailey"), seat("justice_heart", "plaintiff", "Hailey"), recused("justice_memory")] }),
      plaintiff: "Hailey",
      defendant: "Dad",
    });
    expect(score(recusal)).toBe("Hailey 2–0 Dad");
  });

  it("contempt (no vote) keeps the old header", async () => {
    const card = await render(ruled({ outcome: "contempt", contemnor: "Max", vote: null, seats: [], confidencePct: 95 }));
    expect(card.querySelector(".rc-score")).toBeNull();
    expect(card.firstElementChild!.className).toBe("rc-case"); // still on top
    expect(card.querySelector(".rc-title")!.textContent).toBe("Max v. Dad");
    expect(card.querySelector(".rc-outcome")!.textContent).toMatch(/CONTEMPT/);
  });

  it("the meter's gradient spans the whole track, so 30% shows only its red end", async () => {
    const card = await render(ruled({ outcome: "plaintiff", winner: "Max", vote: "2–1", confidencePct: 30, seats: [seat("justice_letter", "plaintiff", "Max")] }));
    const fill = card.querySelector<HTMLElement>(".rc-meter .fill")!;
    expect(fill.style.width).toBe("30%");
    expect(fill.style.backgroundSize).toBe("333.33% 100%");
  });

  it("the judge in the transcript is 👨‍⚖️", async () => {
    loadPage();
    await settle();
    FakeEventSource.last!.emit("court", { id: 5, ts: Date.now(), actor: "judge", kind: "sufficiency.done", message: "The judge has heard enough." });
    await settle();
    expect(document.querySelector("#transcript li:last-child .who")!.textContent).toBe("👨‍⚖️");
  });
});

describe("the gavel: three strikes right after the judge's “The end!!!”", () => {
  class FakeAudio {
    static made: FakeAudio[] = [];
    listeners: Record<string, (() => void)[]> = {};
    playedAt = 0;
    constructor(public src: string) {
      FakeAudio.made.push(this);
    }
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    play() {
      this.playedAt = Date.now();
      return Promise.resolve();
    }
    pause() {}
    end() {
      for (const fn of this.listeners.ended ?? []) fn();
    }
  }

  const closeLive = async (voice: unknown) => {
    FakeAudio.made = [];
    (globalThis as any).Audio = FakeAudio;
    loadPage(); // the case is still being heard when the page opens: a live session
    await settle();
    current = baseCase({
      status: "ruled",
      final: true,
      ruling: { outcome: "plaintiff", winner: "Max", vote: "2–0", confidencePct: 80, seats: [], sentence: null, citedArticles: [], voice },
    });
    FakeEventSource.last!.emit("end", {});
    await settle();
  };

  it("plays the verdict first, then the gavel three times about 0.4 s apart", async () => {
    await closeLive({ status: "ready", url: "/cases/1/verdict.mp3" });
    expect(FakeAudio.made.map((a) => a.src)).toEqual(["/cases/1/verdict.mp3"]);
    FakeAudio.made[0].end(); // "…The end!!!"
    await new Promise((r) => setTimeout(r, 950));
    const strikes = FakeAudio.made.slice(1);
    expect(strikes.map((a) => a.src)).toEqual(["/sfx/gavel.mp3", "/sfx/gavel.mp3", "/sfx/gavel.mp3"]);
    const gaps = [strikes[1].playedAt - strikes[0].playedAt, strikes[2].playedAt - strikes[1].playedAt];
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(350);
      expect(g).toBeLessThan(600);
    }
  });

  it("with no voice today, it's just the gavel", async () => {
    await closeLive({ status: "no_budget" });
    await new Promise((r) => setTimeout(r, 950));
    expect(FakeAudio.made.map((a) => a.src)).toEqual(["/sfx/gavel.mp3", "/sfx/gavel.mp3", "/sfx/gavel.mp3"]);
  });
});

describe("Max: the split box and the sentence", () => {
  const seat = (key: string, name: string, side: string, party: string, pct: number) => ({ key, name, status: "voted", side, party, pct, cites: [] });
  it("“Justice Cody and Justice Grace don't agree with each other.”: no arrows, no percentages", async () => {
    current = baseCase({
      status: "too_close",
      final: true,
      plaintiff: "Max",
      defendant: "Hailey",
      ruling: {
        outcome: "compromise", vote: "1–1", split: true, confidencePct: null, sentence: null, citedArticles: [], voice: { status: "none" },
        seats: [seat("justice_letter", "Justice Cody", "plaintiff", "Max", 72), seat("justice_heart", "Justice Grace", "defendant", "Hailey", 100), { key: "justice_memory", name: "Justice Jack", status: "recused", reason: "recused: no relevant precedent" }],
      },
    });
    loadPage();
    await settle();
    const box = document.querySelector(".rc-split")!;
    expect(box.querySelector(".small")!.textContent).toBe("Justice Cody and Justice Grace don't agree with each other.");
    expect(box.textContent).not.toMatch(/→|%/);
    const css = readFileSync("public/css/ruling-card.css", "utf8");
    expect(css).toMatch(/\.rc-split \{[^}]*border: 2px solid var\(--info\)/);
  });

  it("the judge's quote on the card leaves the sentence out (it has its own box)", async () => {
    current = baseCase({
      status: "ruled",
      final: true,
      ruling: {
        outcome: "plaintiff", winner: "Max", vote: "2–1", confidencePct: 71, citedArticles: [], voice: { status: "none" },
        seats: [seat("justice_letter", "Justice Cody", "plaintiff", "Max", 80)],
        sentence: { level: 3, text: "Hug Grandpa and Grandma" },
        benchVerdict: "Max wins! Sentence: Hug Grandpa and Grandma. The end!!!",
        benchQuote: "Max wins! The end!!!",
      },
    });
    loadPage();
    await settle();
    expect(document.querySelector(".rc-sentence")!.textContent).toBe("Sentence: Hug Grandpa and Grandma");
    expect(document.querySelector(".rc-bench")!.textContent).toBe("“Max wins! The end!!!”");
  });
});

describe("footer credits", () => {
  const credits = "Voice by ElevenLabs · Decisions by TypeSafe Jev · Opinions by Ollama · Records in Box · Mail by AgentMail · Running on Fly.io Sprites";
  for (const page of ["index", "case", "file", "login", "summons", "lawyer"]) {
    it(`${page}.html credits every service`, () => {
      const footer = readFileSync(`public/${page}.html`, "utf8").match(/<footer>(.*)<\/footer>/)![1];
      expect(footer).toContain(credits);
      if (page === "lawyer") expect(footer).toContain("Greg runs on Ollama");
    });
  }
});

describe("after a summons: back on the full case page, controls appear with the ruling", () => {
  const ruled = (over: Record<string, unknown> = {}) =>
    baseCase({
      status: "ruled",
      final: true,
      summons: [{ party: "Dad", status: "answered", via: "in_person", url: null }],
      ruling: { outcome: "plaintiff", winner: "Max", vote: "2–0", confidencePct: 80, seats: [], sentence: null, citedArticles: [], voice: { status: "none" } },
      appeal: { status: null, canAppeal: true, parties: ["Max", "Dad"] },
      mistrial: { offered: true },
      viewer: { isParent: true },
      ...over,
    });

  it("the appeal form and the mistrial button show when the ruling lands, without a reload", async () => {
    current = baseCase({ status: "deliberating", summons: [{ party: "Dad", status: "answered", via: "in_person", url: null }] });
    loadPage();
    await settle();
    expect(document.querySelector("#mistrial-slot button")).toBeNull();
    current = ruled();
    FakeEventSource.last!.emit("court", { id: 20, ts: Date.now(), actor: "judge", kind: "ruling.decided", message: "The court has decided." });
    await settle();
    expect(document.querySelector("#mistrial-slot button")?.textContent).toContain("Declare a mistrial");
    expect(document.querySelector("#appeal-slot form")).toBeTruthy();
  });

  it("the summons button marks that it came from the full case page", async () => {
    current = baseCase({ status: "awaiting_testimony", summons: [{ party: "Dad", status: "pending", via: "in_person", url: "/summons/abc123" }] });
    loadPage();
    await settle();
    expect(document.querySelector<HTMLAnchorElement>("#summons-slot a.btn")?.getAttribute("href")).toBe("/summons/abc123?back=case");
  });

  it("coming back with the browser's Back button (page restored from cache) refreshes and reconnects", async () => {
    current = baseCase({ status: "awaiting_testimony", summons: [{ party: "Dad", status: "pending", via: "in_person", url: "/summons/abc123" }] });
    loadPage();
    await settle();
    const first = FakeEventSource.last!;
    current = ruled(); // decided while the page was in the browser's cache
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await settle();
    expect(FakeEventSource.last).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(document.querySelector("#mistrial-slot button")?.textContent).toContain("Declare a mistrial");
    expect(document.querySelector("#summons-slot a.btn")).toBeNull();
  });

  it("/v/ shows “Open the full case page” when the server says the viewer is signed in, and not otherwise", async () => {
    (window as any).FC_CASE = { number: 1, caseUrl: "/api/v/tok/case", streamUrl: "/api/v/tok/stream", readOnly: true, fullCaseUrl: "/cases/1" };
    current = ruled({ mistrial: { offered: false }, appeal: { status: null, canAppeal: false, parties: ["Max", "Dad"] } });
    loadPage();
    await settle();
    const link = document.querySelector<HTMLAnchorElement>("a.full-case");
    expect(link?.getAttribute("href")).toBe("/cases/1");
    expect(link?.textContent).toContain("Open the full case page");

    (window as any).FC_CASE = { number: 1, caseUrl: "/api/v/tok/case", streamUrl: "/api/v/tok/stream", readOnly: true };
    loadPage();
    await settle();
    expect(document.querySelector("a.full-case")).toBeNull();
  });
});
