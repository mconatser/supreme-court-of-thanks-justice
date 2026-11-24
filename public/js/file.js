"use strict";
(async function () {
  const form = document.getElementById("file");
  const err = document.getElementById("err");
  const submit = document.getElementById("submit");
  const banners = document.getElementById("banners");

  // Character counters
  for (const ta of form.querySelectorAll("textarea[data-max]")) {
    const counter = form.querySelector(`.counter[data-for="${ta.id}"]`);
    const max = Number(ta.dataset.max);
    const update = () => {
      counter.textContent = `${ta.value.length} / ${max}`;
      counter.classList.toggle("over", ta.value.length > max);
    };
    ta.addEventListener("input", update);
    update();
  }

  let d;
  try {
    d = await api("/api/docket");
  } catch (e) {
    err.textContent = e.message;
    return;
  }
  setCourtName(d.cast && d.cast.court);
  if (!d.inSession) {
    banners.append(el("div", { class: "banner recess" }, "🛌 Court is in recess until tomorrow."));
    submit.disabled = true;
  }

  const opts = (sel, placeholder) => {
    sel.replaceChildren(el("option", { value: "" }, placeholder), ...d.parties.map((p) => el("option", { value: p.alias }, p.alias)));
  };
  opts(form.plaintiff, "Choose…");
  opts(form.defendant, "Choose…");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (form.plaintiff.value && form.plaintiff.value === form.defendant.value) {
      err.textContent = "You can't take yourself to court! Pick someone else.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Filing…";
    try {
      const res = await api("/file", {
        json: {
          plaintiff: form.plaintiff.value,
          defendant: form.defendant.value,
          title: form.title.value || undefined,
          claim: form.claim.value,
          relief: form.relief.value,
          response: form.response.value || undefined,
        },
      });
      location.href = res.url;
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      submit.textContent = "🔨 File with the court";
    }
  });
})();
