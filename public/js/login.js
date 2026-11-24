"use strict";
(function () {
  const form = document.getElementById("login");
  const err = document.getElementById("err");
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await api("/login", { json: { passcode: form.passcode.value } });
      location.href = safeNext;
    } catch (ex) {
      err.textContent = ex.message;
      form.passcode.select();
    } finally {
      btn.disabled = false;
    }
  });
})();
