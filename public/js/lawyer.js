"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const OUTCOME = { won: "🏆 won", lost: "😞 lost", compromise: "🤝 compromise", contempt: "🙈 contempt" };
  let state = null;
  let es = null;

  async function load() {
    try {
      state = await api("/lawyer/api/state");
      $("error").textContent = "";
    } catch (e) {
      $("error").textContent = e.message;
      return;
    }
    render();
  }

  function render() {
    const s = state;
    $("title").textContent = s.client ? `Counsel for ${s.client}` : "Counsel's Office";

    const msgs = $("messages");
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    msgs.replaceChildren(
      ...(s.messages.length
        ? s.messages.map((m) => el("li", { class: `msg ${m.role}` }, m.content))
        : [el("li", { class: "empty" }, "Tell your lawyer what happened, and who it was with.")]),
    );
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;

    $("typing").hidden = !s.running;
    $("send").disabled = s.running;

    const box = $("confirm");
    if (s.pending && s.pending.kind === "confirm_filing" && !s.running) {
      const f = s.pending.filing;
      box.hidden = false;
      box.replaceChildren(
        el("div", { style: "font-weight:800" }, "📜 Ready to file?"),
        el(
          "dl",
          {},
          el("dt", {}, "Against"), el("dd", {}, f.defendant),
          el("dt", {}, "Case name"), el("dd", {}, f.title),
          el("dt", {}, "What happened"), el("dd", {}, f.claim),
          el("dt", {}, "What we want"), el("dd", {}, f.relief),
          el("dt", {}, "Our argument"), el("dd", {}, f.argument),
        ),
        el(
          "div",
          { class: "row2" },
          el("button", { class: "btn", type: "button", onclick: () => send({ confirm: true }) }, "👍 Yes, file it!"),
          el("button", { class: "btn secondary", type: "button", onclick: () => send({ confirm: false, text: $("text").value }) }, "👎 Not yet"),
        ),
      );
    } else {
      box.hidden = true;
    }

    $("notes").replaceChildren(...(s.notes.length ? s.notes.map((n) => el("li", {}, n.note)) : [el("li", { class: "muted" }, "Nothing yet.")]));

    const mock = s.mock;
    $("mock-card").hidden = !mock;
    if (mock) {
      $("mock").replaceChildren(
        ...mock.drafts.map((d) =>
          el(
            "div",
            { class: `draft${d.draft === mock.best ? " best" : ""}` },
            el("div", { style: "display:flex;justify-content:space-between;align-items:baseline" }, el("strong", {}, `Draft ${d.draft}${d.draft === mock.best ? " ⭐" : ""}`), el("span", { class: "pct" }, `${d.winPct}%`)),
            el("div", { class: "meter" }, el("div", { style: `width:${d.winPct}%` })),
            d.warning ? el("div", { class: "warn" }, d.warning) : null,
            el("div", { class: "arg" }, d.argument),
          ),
        ),
        el("div", { class: "small muted" }, mock.precedentUsed.length ? `Precedent: ${mock.precedentUsed.join(", ")}` : "No relevant precedent."),
      );
    }

    $("accuracy").textContent = s.accuracy
      ? `Counsel's accuracy: Brier score ${s.accuracy.brier} over ${s.accuracy.finished} case${s.accuracy.finished === 1 ? "" : "s"} (0 is perfect, 0.25 is a coin flip)`
      : "Counsel's accuracy: no finished cases yet.";
    $("cases").replaceChildren(
      ...s.cases.map((c) =>
        el(
          "li",
          {},
          el("a", { href: `/cases/${c.court_case_number}` }, `#${String(c.court_case_number).padStart(4, "0")} ${c.title || ""}`),
          el("span", {}, `${c.predictedPct != null ? `predicted ${c.predictedPct}%` : ""}${c.outcome ? ` · ${OUTCOME[c.outcome] || c.outcome}` : " · pending"}`),
        ),
      ),
    );
    $("lessons").replaceChildren(...(s.lessons.length ? [el("div", { style: "margin-top:10px;font-weight:700" }, "Lessons learned"), ...s.lessons.map((l) => el("div", {}, `• ${l}`))] : []));
  }

  async function send(body) {
    $("error").textContent = "";
    try {
      ensureConnected();
      await api("/lawyer/api/message", { json: body });
      $("text").value = "";
      state.running = true;
      render();
    } catch (e) {
      $("error").textContent = e.message;
    }
  }

  $("say").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("text").value.trim();
    if (text) send({ text });
  });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("say").requestSubmit();
    }
  });
  $("new-case").addEventListener("click", async () => {
    try {
      state = await api("/lawyer/api/new", { method: "POST" });
      render();
    } catch (e) {
      $("error").textContent = e.message;
    }
  });

  function connect() {
    es = new EventSource("/lawyer/stream");
    es.addEventListener("update", () => load());
    es.addEventListener("hello", () => load());
    // The server closes the stream after 10 minutes so an open tab doesn't keep the Sprite awake.
    es.addEventListener("timeout", () => {
      es.close();
      es = null;
    });
  }
  const ensureConnected = () => {
    if (!es) {
      connect();
    }
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && ensureConnected());

  load().then(connect);
})();
