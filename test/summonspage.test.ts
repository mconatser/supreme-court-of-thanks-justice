// @vitest-environment jsdom
/** The summons page (public/js/summons.js): where it sends you once the summons is answered. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKEN = "tok_0123456789abcdefghij";
async function open(search: string, caseUrl: string | null) {
  const html = readFileSync("public/summons.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
  window.history.replaceState({}, "", `/summons/${TOKEN}${search}`);
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ status: "answered", you: "Dad", caseLabel: "Case #0001", title: "Seat", otherParty: "Max", claim: "x", relief: "y", maxLength: 1500, court: "Court", caseUrl }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  (0, eval)(readFileSync("public/js/common.js", "utf8").replace(/^"use strict";/m, ""));
  (0, eval)(readFileSync("public/js/summons.js", "utf8"));
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return document.querySelector<HTMLAnchorElement>("#details a.btn")!;
}

describe("after answering a summons", () => {
  it("from the full case page on a signed-in phone: back to /cases/N", async () => {
    const a = await open("?back=case", "/cases/1");
    expect(a.getAttribute("href")).toBe("/cases/1");
    expect(a.textContent).toContain("Back to the case");
  });
  it("an emailed link (no ?back=case) still goes to the read-only /v/ view, even when signed in", async () => {
    expect((await open("", "/cases/1")).getAttribute("href")).toBe(`/v/${TOKEN}`);
  });
  it("?back=case without a signed-in session (the server gives no caseUrl): /v/", async () => {
    expect((await open("?back=case", null)).getAttribute("href")).toBe(`/v/${TOKEN}`);
  });
});
