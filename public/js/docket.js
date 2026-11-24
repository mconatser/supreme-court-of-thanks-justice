"use strict";
(async function () {
  const list = document.getElementById("docket");
  const banners = document.getElementById("banners");
  const fileBtn = document.getElementById("file-btn");

  async function load() {
    let d;
    try {
      d = await api("/api/docket");
    } catch (e) {
      list.replaceChildren(el("li", { class: "error" }, e.message));
      return;
    }
    setCourtName(d.cast && d.cast.court);

    banners.replaceChildren();
    if (!d.inSession) {
      banners.append(el("div", { class: "banner recess" }, "🛌 Court is in recess until tomorrow."));
      fileBtn.setAttribute("aria-disabled", "true");
      fileBtn.classList.add("secondary");
      fileBtn.textContent = "Court is in recess";
      fileBtn.removeAttribute("href");
    }
    for (const w of d.warnings || []) banners.append(el("div", { class: "banner note small" }, "📖 ", w));
    renderParentTools(d.isParent);

    if (!d.cases.length) {
      list.replaceChildren(el("li", { class: "muted" }, "No cases yet. Be the first to file!"));
      return;
    }
    list.replaceChildren(
      ...d.cases.map((c) => {
        let result = "";
        if (c.status === "ruled" && c.winner) result = `For ${c.winner} · ${c.vote} · ${c.confidencePct}% sure`;
        else if (c.status === "too_close") result = `Too close to call: compromise ordered${c.lean ? ` (leaning ${c.lean.party} ${c.lean.vote})` : ""}`;
        else if (c.status === "contempt") result = "Held in contempt of court";
        if (c.approval === "pending") result += " · 👑 waiting for a parent's OK";
        else if (c.approval === "approved") result += " · 👑 approved";
        else if (c.approval === "denied") result += " · 👑 not approved";
        const summoned = c.summoned && c.summoned.length ? `The court summons ${c.summoned.join(" and ")}` : "";
        return el(
          "li",
          {},
          el(
            "a",
            { href: `/cases/${c.number}`, class: "card case" },
            el("div", { class: "case-top" }, el("span", { class: "num" }, c.label), statusChip(c.status)),
            el("div", { class: "title" }, c.title),
            result && el("div", { class: "small muted" }, result),
            summoned && el("div", { class: "small", style: "color:var(--warn);font-weight:700" }, summoned),
          ),
        );
      }),
    );
  }

  function renderParentTools(isParent) {
    const box = document.getElementById("parent-tools");
    if (!isParent) {
      box.replaceChildren(el("a", { href: "/login?next=/", class: "small muted" }, "Parent? Sign in with the parent passcode"));
      return;
    }
    const status = el("span", { class: "small muted", role: "status" });
    const btn = el("button", { class: "btn secondary", type: "button" }, "🔄 Reload the family list (people.json)");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      status.textContent = "";
      try {
        const r = await api("/admin/reload-people", { method: "POST" });
        status.textContent = `Reloaded: ${r.aliases.join(", ")}`;
        await load();
      } catch (e) {
        status.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    });
    box.replaceChildren(btn, el("div", { style: "margin-top:6px;white-space:pre-line" }, status));
  }

  await load();
  // Refresh occasionally while the page is visible (cheap; the docket is small).
  setInterval(() => document.visibilityState === "visible" && load(), 20000);
})();
