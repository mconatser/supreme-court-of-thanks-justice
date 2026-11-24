"use strict";
(async function () {
  const token = location.pathname.split("/")[2];
  const details = document.getElementById("details");
  const form = document.getElementById("testify");
  const err = document.getElementById("err");
  const ta = document.getElementById("testimony");
  const counter = document.querySelector('.counter[data-for="testimony"]');

  let s;
  try {
    s = await api(`/api/summons/${token}`);
  } catch (e) {
    details.replaceChildren(el("p", { class: "error" }, e.message));
    return;
  }
  setCourtName(s.court);
  ta.dataset.max = s.maxLength;
  const update = () => {
    counter.textContent = `${ta.value.length} / ${s.maxLength}`;
    counter.classList.toggle("over", ta.value.length > s.maxLength);
  };
  ta.addEventListener("input", update);
  update();

  details.replaceChildren(
    el("p", {}, el("strong", {}, `Hear ye, hear ye, ${s.you}!`)),
    el("p", {}, `${s.caseLabel}: ${s.title}. ${s.otherParty} says:`),
    el("blockquote", { class: "filing" }, el("div", { class: "body" }, s.claim), el("div", { class: "by", style: "margin-top:6px" }, `They want: ${s.relief}`)),
  );

  if (s.status !== "pending") {
    document.getElementById("heading").textContent = s.status === "answered" ? "Thanks, the court heard you!" : "This summons has expired";
    details.append(el("p", { class: "muted" }, s.status === "answered" ? "Your testimony is in the record." : "The court decided without you this time."));
    return;
  }
  form.hidden = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const btn = document.getElementById("submit");
    btn.disabled = true;
    try {
      await api(`/summons/${token}`, { json: { testimony: ta.value } });
      form.hidden = true;
      document.getElementById("heading").textContent = "Thanks, the court heard you!";
      details.append(el("p", {}, "🔨 The hearing continues now. The court will send its ruling soon."));
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
})();
