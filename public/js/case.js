"use strict";
(async function () {
  const n = Number(location.pathname.split("/")[2]);
  const transcript = document.getElementById("transcript");
  const thinking = document.getElementById("thinking");
  const note = document.getElementById("stream-note");
  const cardSlot = document.getElementById("card-slot");
  const ICONS = { clerk: "📜", bailiff: "👮", judge: "👩‍⚖️", court: "🏛️", executive: "👑", counsel: "💼" };
  const SEAT_ICONS = { justice_letter: "📖", justice_heart: "❤️", justice_memory: "🧠" };
  let lastId = 0;
  let es = null;
  let closedSeen = false;

  // Events can arrive in bursts (always on replay), and each refresh is a fetch. The newest request
  // wins: an older response that arrives late must never paint the case as it used to be.
  let refreshSeq = 0;
  let latestCase = null;
  async function refresh() {
    const mine = ++refreshSeq;
    const c = await api(`/api/cases/${n}`);
    if (mine !== refreshSeq) return latestCase || c; // a newer refresh is on its way
    latestCase = c;
    document.getElementById("case-title").textContent = `${c.label}: ${c.title}`;
    document.getElementById("header").replaceChildren(
      el("h2", { id: "case-title" }, `${c.label}: ${c.title}`),
      el("p", { class: "muted small", style: "margin-top:-6px" }, statusChip(c.status), "  ", `${c.plaintiff} v. ${c.defendant}`, c.type ? ` · ${c.type}` : ""),
    );
    renderFilings(c.filings);
    renderSummons(c.summons || []);
    renderRuling(c);
    renderAppeal(c);
    renderMistrial(c);
    return c;
  }

  function renderAppeal(c) {
    const slot = document.getElementById("appeal-slot");
    const a = c.appeal;
    if (!a || (!a.canAppeal && !a.status)) return slot.replaceChildren();
    if (a.status) {
      const text = {
        pending: `📣 ${a.by} has appealed. The court is looking for new evidence…`,
        dismissed: a.reason === "contempt" ? `📣 ${a.by}'s appeal was dismissed (contempt of court).` : `📣 ${a.by}'s appeal was dismissed: nothing new.`,
        affirmed: `📣 ${a.by} appealed, and the ruling was AFFIRMED.`,
        reversed: `📣 ${a.by} appealed, and the ruling was REVERSED!`,
      }[a.status];
      return slot.replaceChildren(el("div", { class: "banner" }, el("div", { style: "font-weight:700" }, text), el("div", { class: "small muted", style: "margin-top:4px" }, `New evidence: ${a.evidence}`)));
    }
    const form = el("form", { class: "card", hidden: true, autocomplete: "off" });
    const err = el("p", { class: "error", role: "alert" });
    const party = el("select", { id: "appeal-party", required: true }, el("option", { value: "" }, "Who is appealing?"), ...a.parties.map((p) => el("option", { value: p }, p)));
    const evidence = el("textarea", { id: "appeal-evidence", maxlength: "1500", required: true, placeholder: "What's NEW? The court only hears appeals with new facts or arguments." });
    const submit = el("button", { class: "btn", type: "submit" }, "📣 File the appeal");
    form.append(el("label", { for: "appeal-party" }, "Appeal"), party, el("label", { for: "appeal-evidence" }, "New evidence"), evidence, err, submit);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.textContent = "";
      submit.disabled = true;
      try {
        await api(`/cases/${n}/appeal`, { json: { party: party.value, evidence: evidence.value } });
        liveSession = true;
        closedSeen = false;
        thinking.hidden = false;
        await refresh();
        connect();
      } catch (e) {
        err.textContent = e.message;
        submit.disabled = false;
      }
    });
    const open = el("button", { class: "btn secondary", type: "button", onclick: () => { form.hidden = false; open.hidden = true; } }, "📣 Appeal (new evidence only)");
    slot.replaceChildren(open, form);
  }

  function renderMistrial(c) {
    const slot = document.getElementById("mistrial-slot");
    if (c.status === "vacated") {
      return slot.replaceChildren(el("div", { class: "banner recess" }, "🌀 Mistrial: these proceedings never happened. (The Box record remembers.)"));
    }
    if (!c.mistrial || !c.mistrial.offered) return slot.replaceChildren();
    const err = el("p", { class: "error", role: "alert" });
    const sure = el(
      "div",
      { class: "banner", hidden: true },
      el("div", { style: "font-weight:700" }, "Rewind the whole courthouse to before this ruling?"),
      el("div", { class: "small muted", style: "margin:4px 0 10px" }, "The ruling, and everything since, will never have happened. Box keeps a VACATED record."),
      el(
        "div",
        { class: "row2" },
        el("button", { class: "btn", type: "button", onclick: () => declare() }, "🌀 Yes, rewind time"),
        el("button", { class: "btn secondary", type: "button", onclick: () => { sure.hidden = true; open.hidden = false; } }, "Cancel"),
      ),
      err,
    );
    const open = el("button", { class: "btn secondary", type: "button", onclick: () => { sure.hidden = false; open.hidden = true; } }, "⚠️ Declare a mistrial (parent only)");
    slot.replaceChildren(open, sure);

    async function declare() {
      err.textContent = "";
      let before;
      try {
        before = (await api("/healthz")).bootedAt;
        await api(`/cases/${n}/mistrial`, { method: "POST" });
      } catch (e) {
        err.textContent = e.message;
        return;
      }
      if (es) es.close();
      closedSeen = true;
      const msg = el("div", {}, "Mistrial declared. Rewinding time…");
      document.body.append(el("div", { class: "wake-splash" }, el("div", { class: "wake-card" }, el("div", { class: "wake-gavel" }, "🌀"), el("div", { class: "wake-title" }, "MISTRIAL!"), msg)));
      // The Sprite restarts from the checkpoint; wait until it answers with a new boot time.
      const started = Date.now();
      const poll = async () => {
        try {
          const h = await (await fetch("/healthz", { cache: "no-store" })).json();
          if (h.bootedAt !== before) {
            msg.textContent = "These proceedings never happened. (The Box record remembers.)";
            setTimeout(() => location.reload(), 4000);
            return;
          }
        } catch { /* the courthouse is mid-rewind */ }
        if (Date.now() - started > 120000) {
          msg.textContent = "Time travel is taking a while. Try reloading in a minute.";
          return;
        }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2500);
    }
  }

  function renderSummons(list) {
    const slot = document.getElementById("summons-slot");
    const pending = list.filter((s) => s.status === "pending");
    slot.replaceChildren(
      ...pending.map((s) =>
        el(
          "div",
          { class: "banner", style: "border-color:var(--warn)" },
          el("div", { style: "font-weight:700" }, `📜 The court summons ${s.party}!`),
          el("div", { class: "small muted", style: "margin:4px 0 10px" }, s.via === "email" ? "A summons was emailed, or answer here if they're with you." : "Hand them the phone so they can tell their side."),
          el("a", { class: "btn", href: s.url }, `🗣️ ${s.party}: tell your side`),
        ),
      ),
    );
  }

  function renderFilings(filings) {
    document.getElementById("filings").replaceChildren(
      ...filings.map((f) =>
        el("div", { class: `filing${f.struck ? " struck" : ""}` }, el("div", { class: "by" }, `${f.author} · ${f.kind}`), el("div", { class: "body" }, f.body)),
      ),
    );
  }

  function renderRuling(c) {
    const r = c.ruling;
    if (!r) return cardSlot.replaceChildren();
    let outcome, outcomeClass = "";
    if (r.outcome === "contempt") { outcome = `${r.contemnor || "Someone"} is in CONTEMPT!`; outcomeClass = "contempt"; }
    else if (r.outcome === "compromise") { outcome = "Too close to call: compromise!"; outcomeClass = "too_close"; }
    else outcome = `Ruling for ${r.winner}`;

    const seats = (r.seats || []).map((s) =>
      el(
        "div",
        { class: `rc-seat ${s.status}${s.status === "voted" && s.side === r.outcome ? " winner" : ""}` },
        el("div", { class: "icon" }, SEAT_ICONS[s.key] || "⚖️"),
        el("div", { class: "name" }, s.name),
        s.status === "voted"
          ? [
              el("div", { class: "pick" }, s.party),
              el("div", { class: "pct" }, `${s.pct}%`),
              s.cites && s.cites.length
                ? el("div", { class: "cites" }, "Cites ", s.cites.map((k) => `${k.label}${k.title ? `: ${k.title}` : ""}`).join("; "))
                : null,
            ]
          : el("div", { class: "pick" }, s.reason),
      ),
    );

    const pct = r.confidencePct;
    const card = el(
      "div",
      { class: "ruling-card" },
      el("div", { class: "rc-case" }, c.label),
      el("div", { class: "rc-title" }, c.title),
      seats.length ? el("div", { class: "rc-seats" }, seats) : null,
      el("div", { class: `rc-outcome ${outcomeClass}` }, outcome),
      r.outcome === "compromise"
        ? el("div", { class: "rc-vote" }, r.lean ? `Leaning ${r.lean.party} ${r.lean.vote}` : `Split ${r.vote}`)
        : r.vote ? el("div", { class: "rc-vote" }, `Vote ${r.vote}`) : null,
      r.split
        ? el(
            "div",
            { class: "rc-split" },
            el("div", { class: "label" }, "⚖️ The justices strongly disagree"),
            el(
              "div",
              { class: "small" },
              (r.seats || []).filter((s) => s.status === "voted").map((s) => `${s.name} → ${s.party} (${s.pct}%)`).join(" · "),
            ),
          )
        : pct != null && r.outcome !== "contempt"
        ? el(
            "div",
            { class: "rc-meter" },
            el("div", { class: "label" }, el("span", {}, "How sure the court is"), el("span", {}, `${pct}%`)),
            el("div", { class: "track" }, el("div", { class: "fill", style: `width:${pct}%` })),
          )
        : null,
      r.sentence ? el("div", { class: "rc-sentence" }, `Sentence: ${r.sentence.text}`) : null,
      r.benchVerdict ? el("blockquote", { class: "rc-bench" }, `“${r.benchVerdict}”`) : null,
      voiceControl(r.voice),
      r.petitionRecommended ? approvalBlock(c) : null,
      r.citedArticles && r.citedArticles.length
        ? el("div", { class: "rc-articles" }, "Cites ", r.citedArticles.map((a) => `Article ${a.number}${a.title ? ` (${a.title})` : ""}`).join(", "))
        : null,
    );
    cardSlot.replaceChildren(card);

    if (r.opinionMd) {
      document.getElementById("opinion-card").hidden = false;
      document.getElementById("opinion").innerHTML = renderMarkdown(r.opinionMd);
    }
  }

  function approvalBlock(c) {
    if (c.approval === "approved") return el("div", { class: "rc-recommend" }, "👑 Approved by the Executive Branch. It's official!");
    if (c.approval === "denied") return el("div", { class: "rc-recommend" }, "👑 The Executive Branch said no. The house rule stays the same.");
    const what = c.ruling && c.ruling.outcome === "compromise" ? "The compromise is recommended" : "Recommended";
    const box = el("div", { class: "rc-recommend" }, `${what} to the Executive Branch (a parent) for approval.`);
    if (c.viewer && c.viewer.isParent) {
      const err = el("div", { class: "error small" });
      const decide = (decision) => async () => {
        try {
          await api(`/cases/${n}/approval`, { json: { decision } });
          await refresh();
        } catch (e) {
          err.textContent = e.message;
        }
      };
      box.append(
        el("div", { class: "row2", style: "margin-top:10px" },
          el("button", { class: "btn", type: "button", onclick: decide("approve") }, "👍 Approve"),
          el("button", { class: "btn secondary", type: "button", onclick: decide("deny") }, "👎 Deny")),
        err,
      );
    } else {
      box.append(el("div", { class: "small muted" }, "Waiting for a parent's OK."));
    }
    return box;
  }

  function addEvent(e) {
    if (e.id <= lastId) return;
    lastId = e.id;
    transcript.append(
      el(
        "li",
        { class: `kind-${e.kind}` },
        el("div", { class: "who" }, ICONS[e.actor] || "•"),
        el("div", {}, el("div", { class: "actor" }, e.actor), el("div", { class: "msg" }, e.message)),
      ),
    );
    if (["ruling.decided", "opinion.written", "screening.done", "summons.issued", "testimony.received", "summons.expired", "appeal.decided", "appeal.dismissed", "appeal.opinion.written"].includes(e.kind)) refresh().catch(() => {});
  }

  async function onClosed() {
    closedSeen = true;
    thinking.hidden = true;
    if (es) es.close();
    const c = await refresh().catch(() => null);
    const seal = document.querySelector(".bar .seal, .bar .back");
    if (seal) { seal.classList.remove("gavel-flash"); void seal.offsetWidth; seal.classList.add("gavel-flash"); }
    // Only bang the gavel for hearings watched live, not when reopening an old case.
    if (liveSession) ceremony(c && c.ruling && c.ruling.voice);
  }

  let player = null;
  function stopAudio() {
    if (player) { player.pause(); player = null; }
  }

  /** The gavel, then the verdict. Phones may block autoplay; then the ▶ button pulses instead. */
  function ceremony(voice) {
    stopAudio();
    const gavel = new Audio("/sfx/gavel.mp3");
    player = gavel;
    let moved = false;
    const next = () => {
      if (moved) return;
      moved = true;
      if (voice && voice.status === "ready") playVerdict(voice.url);
    };
    gavel.addEventListener("ended", next);
    gavel.addEventListener("error", next); // no gavel.mp3 yet: go straight to the verdict
    gavel.play().catch((e) => (e && e.name === "NotAllowedError" ? nudgePlay() : next()));
  }

  function playVerdict(url) {
    stopAudio();
    const a = new Audio(url);
    player = a;
    const btn = document.getElementById("play-verdict");
    if (btn) btn.textContent = "🔊 The judge speaks…";
    a.addEventListener("ended", () => { if (btn) btn.textContent = "▶ Hear the verdict again"; });
    a.play().catch(() => nudgePlay());
  }

  function nudgePlay() {
    const btn = document.getElementById("play-verdict");
    if (btn) { btn.classList.add("pulse"); btn.textContent = "▶ Tap to hear the verdict"; }
  }

  function voiceControl(voice) {
    if (!voice || voice.status === "none") return null;
    if (voice.status === "no_budget") return el("div", { class: "rc-voice-note" }, "🤐 The judge has lost their voice for today.");
    if (voice.status === "unavailable") return el("div", { class: "rc-voice-note" }, "🎙️ The judge's microphone isn't working, so here's the verdict in writing.");
    return el("button", { class: "btn", type: "button", id: "play-verdict", style: "margin-top:12px", onclick: () => playVerdict(voice.url) }, "▶ Hear the verdict");
  }

  let liveSession = false;

  function connect() {
    note.textContent = "";
    es = new EventSource(`/cases/${n}/stream?after=${lastId}`);
    es.addEventListener("court", (m) => {
      addEvent(JSON.parse(m.data));
    });
    // The server says "end" once the case is really over (a replayed case.closed during an appeal isn't).
    es.addEventListener("end", () => onClosed());
    es.addEventListener("timeout", () => {
      es.close();
      thinking.hidden = true;
      note.replaceChildren("The court stopped streaming to save power. ", el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); thinking.hidden = false; connect(); } }, "Tap to reconnect"));
    });
    es.onerror = () => {
      if (closedSeen) es.close();
      // otherwise EventSource reconnects by itself (with Last-Event-ID)
    };
  }

  try {
    const c = await refresh();
    const d = await api("/api/docket").catch(() => null);
    if (d) setCourtName(d.cast && d.cast.court);
    thinking.hidden = c.final;
    liveSession = !c.final; // only bang the gavel for hearings watched live
    connect();
  } catch (e) {
    document.getElementById("case-title").textContent = e.message;
  }
})();
