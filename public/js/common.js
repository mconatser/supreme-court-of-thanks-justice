// Shared helpers. Plain browser JS, no build step.
"use strict";

async function api(path, opts = {}) {
  const init = { headers: { accept: "application/json" }, credentials: "same-origin", ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith("/login")) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error("Please enter the passcode first.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Something went wrong (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** el("div", { class: "x" }, "text", child) — text is always set via textContent (no HTML injection). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Tiny, safe Markdown: paragraphs, **bold**, *italic*, line breaks. Input is escaped first. */
function renderMarkdown(md) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return esc(md || "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/^#{1,6}\s+(.*)$/gm, "<strong>$1</strong>"))
    .map((p) => p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>"))
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const STATUS_LABELS = {
  filed: ["Filed", "open"],
  screening: ["Screening", "open"],
  gathering: ["Hearing", "open"],
  awaiting_testimony: ["Waiting for testimony", "open"],
  deliberating: ["Deliberating", "open"],
  ruled: ["Ruled", "ruled"],
  too_close: ["Too close: compromise", "too_close"],
  contempt: ["Contempt!", "contempt"],
  appealed: ["On appeal", "open"],
  vacated: ["Vacated", "too_close"],
};

function statusChip(status) {
  const [label, cls] = STATUS_LABELS[status] || [status, "open"];
  return el("span", { class: `chip ${cls}` }, label);
}

function setCourtName(name) {
  if (!name) return;
  document.querySelectorAll("[data-court-name]").forEach((n) => (n.textContent = name));
  document.title = document.title.replace(/^Family Court/, name);
}

/**
 * "All rise" splash: a Sprite pauses when idle and wakes on the next request. If this server
 * booted moments ago, say how long the judge took to reconvene. The page request itself is what
 * woke the court, so time it with Navigation Timing; fall back to timing /healthz.
 */
(function wakeSplash() {
  const WAKE_WINDOW_MS = 10000;
  async function check() {
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    const pageWait = nav && nav.responseStart > 0 ? nav.responseStart - nav.requestStart : 0;
    const t0 = performance.now();
    let health;
    try {
      const res = await fetch("/healthz", { cache: "no-store" });
      health = await res.json();
    } catch {
      return;
    }
    const pingWait = performance.now() - t0;
    if (typeof health.uptimeMs !== "number" || health.uptimeMs > WAKE_WINDOW_MS + pageWait + pingWait) return;
    try {
      if (sessionStorage.getItem("fc_woke") === String(health.bootedAt)) return; // once per wake
      sessionStorage.setItem("fc_woke", String(health.bootedAt));
    } catch {}
    const secs = (Math.max(pageWait, pingWait) / 1000).toFixed(1);
    const splash = el(
      "div",
      { class: "wake-splash", role: "status" },
      el("div", { class: "wake-card" }, el("div", { class: "wake-gavel" }, "⚖️"), el("div", { class: "wake-title" }, "All rise!"), el("div", {}, `The judge was napping. Court reconvened in ${secs} s.`)),
    );
    splash.addEventListener("click", () => splash.remove());
    document.body.append(splash);
    setTimeout(() => splash.classList.add("leaving"), 2600);
    setTimeout(() => splash.remove(), 3200);
  }
  if (document.readyState === "complete") check();
  else window.addEventListener("load", check);
})();
