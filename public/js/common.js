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
