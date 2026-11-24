# Family Court: Build Spec (Fly.io Hacksgiving 2026)

> Working title. Max names the court, the judge, the three justices and the lawyer.
> Until he does, the placeholders are `{{COURT}}`, `{{JUDGE}}` and `{{LAWYER}}`.

---

## 0. Read this first (instructions for Claude Code)

- **Hackathon:** Fly.io Hacksgiving, Nov 23–29, 2026. Submissions close at midnight PST on Sunday, Nov 29.
- **Hard requirements:**
  1. A *personal agent*
  2. that runs on a Fly.io **Sprite**
  3. and uses **at least one Sprites connector**.
- **Submission:** a code link, a demo, a short description, and a post tagging @flydotio.
- **Before writing code on a Sprite:** read `/.sprite/llm.txt` and `/.sprite/llm-dev.txt`. They cover platform behavior and the installed runtimes.
- **Connector calls:**
  - Go through the Sprites gateway with **no `Authorization` header**.
  - Only work from inside a running Sprite. Calls from anywhere else get a 401.
  - Off-Sprite, use `GATEWAY_MODE=stub`.
- **Build one phase at a time (§13).**
  - Every phase ends with its acceptance checks passing, followed by a commit.
  - Don't start the next phase early.
  - Propose a plan at the start of each phase and wait for Mark's OK.
- **Keep it small:**
  - Plain HTML/CSS and vanilla JS on the front end.
  - No bundler, and no framework on the client.
- **Privacy:**
  - Never commit real family names, emails or case data.
  - `data/`, `.env` and `people.json` are gitignored.
  - Fixtures and demo data use made-up "court aliases".
- **An 11-year-old co-builds this:**
  - Keep copy, errors and UI text PG and friendly.
  - Max owns everything in `content/`. Don't rewrite his content without asking.

---

## 1. Pitch (draft submission description)

**{{COURT}}: my son's personal AI lawyer, arguing his cases in front of a judge that isn't an LLM.**

- **The lawyer** is an Ollama-powered agent on its own Sprite. It:
  - interviews its client,
  - reads the Family Code (which my son wrote, stored in Box),
  - runs mock trials against TypeSafe's Jev decision model to choose its best argument,
  - and files the case.
- **The courthouse** is a separate Sprite. It:
  - screens filings for contempt of court (bribing the judge is a crime here),
  - rules with a three-justice panel of Jev questions that returns calibrated probabilities,
  - sentences according to my son's own sentencing guidelines,
  - files the record to Box,
  - and reads the verdict aloud, gavel included.
- **The two Sprites can't touch each other's tools.** Connector access policies enforce the separation of powers. When the lawyer tries to contact a witness directly, it gets a 403.
- **Appeals require new evidence.**
- **A mistrial rewinds the courthouse Sprite to its checkpoint from before the ruling.** The Box record remembers what the Sprite forgot.

---

## 2. Cast and architecture

```
 Max (the client)                          Anyone at the table (no lawyer)
      │  /lawyer  (lawyer passcode)                   │  /file  (court passcode)
      ▼                                               ▼
┌──────────────────────────────┐  HTTPS +      ┌───────────────────────────────────┐
│ LAWYER  Sprite: fc-lawyer     │  COURT_TOKEN  │ COURTHOUSE  Sprite: fc-court       │
│ Ollama tool-calling loop      │ ────────────▶ │ hearing pipeline                   │
│ tools: law library, precedent,│ file case,    │ Jev: case type, contempt,          │
│  ask client, mock trial (Jev),│ watch (SSE),  │  sufficiency, 3-justice panel,     │
│  file case, watch hearing     │ law library,  │  sentence, appeal                  │
│ memory: lawyer.db             │ precedent     │ Ollama: written opinion            │
│ connectors: TypeSafe, Ollama  │               │ Box: Family Code + court records   │
└──────────────────────────────┘               │ AgentMail: summonses and notices   │
        ✗ Box / AgentMail / ElevenLabs          │ ElevenLabs: spoken verdict         │
          denied by connector policy            │ memory: court.db                   │
          (the "ex parte" 403 demo)             └───────────────────────────────────┘
```

- **The agent** is the lawyer: an LLM running in a loop with tools, acting for one person.
- **The courthouse** is the environment it acts in. It's a deterministic workflow, and every branch in it is decided by a Jev probability.
- **Phases 1–3:** both apps run in one process on one Sprite (`MODE=all`).
- **Phase 4:** they split onto two Sprites. Design for the split from day one:
  - The lawyer talks to the court only over HTTP at `COURT_URL`.
  - The lawyer never imports court internals.

**Sprite names** (connector policies key off these prefixes, §12):

| Sprite | Purpose |
|---|---|
| `fc-court-dev` | Development. Claude Code runs here. |
| `fc-court` | Production courthouse, from Wednesday |
| `fc-lawyer` | Production lawyer, from Friday |

---

## 3. Stack

- **Runtime:** Node (whatever version ≥ 20 is on the Sprite) with TypeScript, run through `tsx`. There's no build step.
- **Server:** `hono` + `@hono/node-server`, using `streamSSE` from `hono/streaming` for server-sent events (SSE).
- **Storage:** `better-sqlite3` in WAL mode, in two files: `data/court.db` and `data/lawyer.db`.
- **Validation:** `zod`.
- **Tests:** `vitest`, in stub mode only.
- **Front end:** static files in `public/`, vanilla JS, and `EventSource` for SSE.

---

## 4. Repo layout

```
family-court/
  SPEC.md  SETUP.md  MISSIONS.md  README.md (Phase 5)
  .env.example  .gitignore  package.json  tsconfig.json
  scripts/
    smoke.sh          # connector smoke test (already written)
    start.sh          # loads .env, execs node --import tsx src/main.ts
    deploy.sh         # run from laptop: pull, install, restart service on a Sprite
  content/            # Max's files; the Family Code itself lives in Box
    family-code.md    # his draft; upload to Box, then Box is the source of truth
    judge-persona.md
    lawyer-persona.md
  src/
    main.ts           # MODE=all|court|lawyer; mounts the apps on one Hono server
    shared/
      gateway.ts      # connector discovery + fetch; live and stub modes
      jev.ts          # TypeSafe Jev client + types
      ollama.ts       # chat, tools, JSON-schema output
      budget.ts       # daily spend guards
      auth.ts         # passcode sessions, COURT_TOKEN check, rate limit
      panel.ts        # the justice questions; shared by court and lawyer mock trials
    court/
      app.ts  db.ts  hearing.ts  opinion.ts  box.ts  mail.ts  voice.ts
      summons.ts  appeal.ts  mistrial.ts  familyCode.ts
    lawyer/
      app.ts  db.ts  agent.ts  tools.ts  memory.ts
  public/
    index.html  file.html  case.html  summons.html  lawyer.html
    css/court.css  css/ruling-card.css   # Max designs the ruling card
    js/*.js
    sfx/gavel.mp3     # Max makes this in ElevenLabs Sound Effects
  fixtures/           # canned connector responses for GATEWAY_MODE=stub
  test/
    cases/*.json      # Max's test cases (made-up aliases), including bribes
    *.test.ts
  data/               # gitignored: SQLite DBs, audio cache, DEPLOY_ID
```

---

## 5. Config (`.env`, see `.env.example`)

| Group | Keys |
|---|---|
| Process | `MODE`, `PORT`, `PUBLIC_BASE_URL` (the Sprite's https URL, used in summons links) |
| Gateway | `GATEWAY_MODE` (`live` or `stub`), plus optional `TYPESAFE_BASE`, `OLLAMA_BASE`, `BOX_BASE`, `AGENTMAIL_BASE`, `ELEVENLABS_BASE` to override discovery |
| Models | `JEV_MODEL` (start with `jev-latest`, then pin to the version the API reports), `OLLAMA_MODEL` |
| Court | `COURT_URL`, `COURT_TOKEN`, `COURT_PASSCODE`, `PARENT_PASSCODE`, `LAWYER_PASSCODE`, `SESSION_SECRET` |
| Connector IDs | `BOX_FAMILY_CODE_FILE_ID`, `BOX_RECORDS_FOLDER_ID`, `AGENTMAIL_INBOX_ID`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` |
| Behavior | `SUMMONS_TIMEOUT_MIN` (15), `MISTRIAL_ENABLED` (false) |
| Budgets | `JEV_DAILY` (300), `OLLAMA_DAILY` (150), `TTS_CHARS_DAILY` (3000), `EMAIL_DAILY` (40) |

`people.json` (gitignored) lists the family:

```json
[{ "id": "dad", "name": "Dad", "alias": "The Big Cheese", "email": "", "role": "parent" }]
```

- `role` is `parent` or `kid`.
- `email` is optional. Anyone without an email gets their summons in person on the case page.

API keys never appear in `.env`, because the connectors hold them.

---

## 6. Connector clients (`src/shared`, `src/court`)

### 6.1 Gateway (`gateway.ts`)

1. **URL pattern:** `https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>`. Whatever follows the connection ID is forwarded to the provider with the stored credential attached.
2. **Discovery:**
   - At startup, `GET https://api.sprites.dev/v1/gateway/list` returns each connected provider with a `gateway_base_url` and a `usage_snippet`.
   - **The exact JSON shape isn't documented, so parse defensively.** Walk the response, collect every object that has a `gateway_base_url`, and key each one by the provider slug (the path segment after `/gateway/` in that URL).
   - An env `*_BASE` value overrides discovery.
   - Log the `usage_snippet` for each provider the first time you use it, and follow it when it disagrees with this spec.
3. **`gw(provider, path, init)`** calls `fetch(base + path, init)`. Never set `Authorization`.
   - **401:** the call didn't come from inside a Sprite.
   - **403:** the access policy doesn't match this Sprite, or the endpoint is blocked. Connectors deny everything by default.
4. **Stub mode:**
   - `GATEWAY_MODE=stub` serves `fixtures/<provider>/<name>.json`, picked by a small matcher (provider + method + path prefix).
   - TypeSafe stubs should vary their answers by keywords in `state`. For example, a filing that contains "dessert" or "I'll give you" scores contempt 0.95, so tests are meaningful.

### 6.2 TypeSafe Jev (`jev.ts`)

The connector forwards only `POST /v1/systemone` and `GET /v1/models`.

```ts
type Noul   = { type: 'noul';   instructions: string; criteria?: { true: string; false: string } };
type Choice = { type: 'choice'; instructions: string; criteria: Record<string, string | null> }; // ≤ 255 options
type Score  = { type: 'score';  instructions: string;
                criteria: (string | { what: string; examples?: string[] })[] };              // 2–10 levels, index = level

// POST {TYPESAFE_BASE}/v1/systemone
type JevRequest = { model: string; state: string | object; questions: Record<string, Noul | Choice | Score> };

type JevResponse = {
  model: string;                                    // e.g. "jev-1.14.0"; log it, then pin JEV_MODEL to it
  answers: Record<string,
    | { type: 'noul';   noul: number }                                        // P(yes), 0–1; no confidence field
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: 'score';  score: number;  confidence: number; probabilities: Record<string, number>; legend: Record<string, string> }>;
  usage: { input_tokens: number; output_tokens: number };
};
```

**Rules for using Jev:**

- **Batch the questions.** Jev evaluates every question in parallel, against the same state, in isolation. Put all of a step's questions in one request.
- **Keep each question atomic.** One judgment per question; combine the results in code.
- **Phrase `noul` questions so a high value means yes.**
  - Start with thresholds of 0.7 (yes) and 0.3 (no). Treat anything in between as "unsure".
  - Don't over-tune the thresholds to a handful of test cases.
- **Jev is unreliable at counting and comparing dates.** Compute those in code and pass the results in `state` as facts.
- **Context is about 32k tokens.** The Family Code, plus the filings, plus up to 8 precedent summaries, must fit.
- **Pin the model version** once the thresholds feel right. Values can shift between Jev releases.

### 6.3 Ollama Cloud (`ollama.ts`)

- **Call:** `POST {OLLAMA_BASE}/api/chat` with `{ model, messages, stream: false, tools?, format? }`. The response is `{ message: { role, content, tool_calls? } }`.
- **Confirm the path** against the connector's `usage_snippet`. It may expose the native `/api/*` endpoints or the OpenAI-compatible `/v1/*` ones; use whichever it shows.
- **`OLLAMA_MODEL`** must be a cloud model that supports tool calling. Prefer a cheaper one.
- **Use `format`** (a JSON schema) whenever the code needs structured output, such as opinions.

### 6.4 Box (`court/box.ts`, court only)

- **Folder layout in Box:**
  - `Family Court/`
    - `Family Code.md` (Max's)
    - `Court Records/`
- **Read the Family Code:**
  - `GET /2.0/files/{BOX_FAMILY_CODE_FILE_ID}/content`. Box answers with a redirect to a download URL; follow it.
  - Cache the text by version: `GET /2.0/files/{id}?fields=file_version,modified_at`.
  - Re-read when the version changes, or when a parent hits `POST /admin/reload-code`.
- **File the record:** upload `Case-0007.md` (rendered opinion, votes, sentence) to `BOX_RECORDS_FOLDER_ID`.
  - Box uploads use a different domain (`upload.box.com`). Check the Box connector's `usage_snippet` to see how the gateway routes uploads.
  - The connector needs read and write permission even for downloads, and caps uploads at 50 MiB.
- **Vacate a record:** upload a new version of the record with a VACATED banner. If versioning is awkward through the gateway, upload `Case-0007 (VACATED).md` instead.
- **Parse the Family Code:**
  - Articles are `## Article N. Title` headings.
  - Sentencing guidelines are a numbered list (0–4) under `## Sentencing Guidelines`.
  - If parsing fails, fall back to built-in default tiers and show a polite warning on the docket.

### 6.5 AgentMail (`court/mail.ts`, court only)

- **Inbox:** created once during setup, giving `AGENTMAIL_INBOX_ID`. That's the clerk's address.
- **Send:** `POST /v0/inboxes/{inbox_id}/messages/send` with `{ to, subject, text, html }`.
- **What it sends:**
  - summonses (with a link to `/summons/:token`),
  - notices of ruling,
  - and contempt notices.
- **Recipients:** only people in `people.json` who have an email. Respect `EMAIL_DAILY`.

### 6.6 ElevenLabs (`court/voice.ts`, court only)

- **Text to speech:** `POST /v1/text-to-speech/{ELEVENLABS_VOICE_ID}` with `{ text, model_id }` returns `audio/mpeg`.
  - If the ElevenLabs connector doesn't forward this path, add a **Custom API** connector for `https://api.elevenlabs.io` that sends the key in the `xi-api-key` header.
- **Cache** to `data/audio/case-<n>.mp3`. Never synthesize the same verdict twice.
- **Bench verdicts are capped at 300 characters.** The free plan gives about 10 minutes of speech a month, and `TTS_CHARS_DAILY` enforces the cap.
- **The gavel** is a static file: Max makes `public/sfx/gavel.mp3` in ElevenLabs' Sound Effects UI.
- **Attribution:** free-plan audio is non-commercial and requires credit. Put "Voice by ElevenLabs" in the footer.

---

## 7. Data model

### `data/court.db`

```sql
cases(
  id INTEGER PRIMARY KEY, number INTEGER UNIQUE,          -- shown as Case #0007
  title TEXT, plaintiff TEXT, defendant TEXT,
  type TEXT,                                              -- complaint | petition | declaration
  filed_by TEXT,                                          -- lawyer | pro_se
  claim TEXT, relief TEXT,
  status TEXT,                                            -- see 8.2
  created_at INTEGER, ruled_at INTEGER)

filings(id, case_id, author, kind, body, contempt_noul REAL, struck INTEGER, created_at)
  -- kind: complaint | argument | response | testimony | evidence | appeal

events(id INTEGER PRIMARY KEY, case_id, ts, actor, kind, message, data_json)
  -- the hearing transcript; the SSE stream replays this table

rulings(id, case_id, round,                               -- round 0 = trial, 1 = appeal
  panel_json, outcome, vote, case_confidence REAL,
  sentence_level INTEGER, sentence_text, opinion_md, bench_verdict,
  cited_articles_json, box_file_id, audio_path, checkpoint_id, created_at)

summons(id, case_id, person_id, token UNIQUE, status, sent_via, created_at, answered_at)

budget(day TEXT, key TEXT, used INTEGER, PRIMARY KEY(day, key))
```

### `data/lawyer.db`

```sql
conversations(id, case_ref, role, content, created_at)    -- chat with the client
steps(id, case_ref, ts, tool, input_json, output_json)    -- shown live as "counsel's notes"
cases(case_ref, court_case_number, predicted REAL, outcome TEXT, vote TEXT, created_at)
lessons(id, text, created_at)                             -- one line per finished case
```

---

## 8. The courthouse

### 8.1 Routes

| Route | Who | What |
|---|---|---|
| `GET /` | court passcode | Docket: cases, status chips, "File a case" |
| `GET /file`, `POST /file` | court passcode | File without a lawyer |
| `GET /cases/:n` | court passcode | Case page: live transcript, ruling card, play verdict |
| `GET /cases/:n/stream` | court passcode | SSE. Replays `events` (supports `Last-Event-ID`), then goes live. Closes when the case reaches a final status, or after 10 minutes |
| `GET /summons/:token`, `POST` | token | Testimony form (≤ 1000 chars) |
| `POST /cases/:n/appeal` | court passcode | New evidence (Phase 5) |
| `POST /cases/:n/mistrial` | parent passcode | Phase 5 |
| `GET /law-library` | COURT_TOKEN or passcode | Family Code text plus parsed articles |
| `GET /api/precedent?q=` | COURT_TOKEN | Up to 8 past rulings (keyword match): question, outcome, vote, articles |
| `POST /api/cases` | COURT_TOKEN | The lawyer files a case. Returns `{ number, url }` |
| `POST /admin/reload-code` | parent passcode | Refresh the Family Code from Box |
| `GET /healthz` | public | `{ ok, bootedAt, deployId }` |

### 8.2 The hearing pipeline (`hearing.ts`)

**Case statuses:**

```
filed → screening → (contempt) | gathering → (awaiting_testimony) → deliberating
      → ruled | too_close                        (ruled → appealed → ruled) | vacated
```

**`runHearing(caseId)`** runs these steps. Every step appends to `events`, and the SSE stream reads from that table.

| # | Actor | Step |
|---|---|---|
| 1 | clerk | "All rise! Case #0007, Pip v. The Big Cheese." |
| 2 | bailiff | **Screening.** One Jev request with `contempt` (noul) for each new filing, plus `case_type` (choice) on the first round. |
| 3 | clerk | **Law library.** Load the Family Code (cached). |
| 4 | judge | **Sufficiency.** `sufficient` (noul). If it's below 0.7 and the unheard party hasn't been summoned yet, issue a summons (§8.6), set status `awaiting_testimony`, and pause. |
| 5 | judge | **Deliberation.** One Jev request containing the three justices plus `sentence` (complaints only). |
| 6 | judge | **Ruling.** Apply the confidence rules in §8.4. |
| 7 | clerk | **Opinion.** Ollama writes it (§8.5). |
| 8 | clerk | **Record.** Upload to Box, synthesize the audio, email notices to the parties. |
| 9 | bailiff | **Gavel.** The final event, `case.closed`. The client plays the gavel sound, then the verdict audio. |

- **Make steps idempotent**, keyed by which events already exist for the case.
- **On startup, run `resumeOpenHearings()`.** It continues any case in `screening`, `gathering` or `deliberating`.

**Sprite sleep:**

- A Sprite pauses after about 30 seconds of idle time. A cold wake takes 1–2 seconds and starts processes fresh. Both kinds of pause drop open TCP connections.
- So a hearing runs while someone is watching its SSE stream:
  - The case page opens the stream right after filing.
  - The lawyer subscribes to the stream after it files.
- `EventSource` reconnects on its own, and `Last-Event-ID` replay plus startup resume cover the gaps.
- **Optional (Phase 5):** try the Sprites Tasks API for hearings. It keeps a Sprite awake until the current run finishes.

### 8.3 The Jev questions (`shared/panel.ts`, exact wording; tune later)

**State** is a JSON object:

```
{
  case:           { number, title, type, plaintiff, defendant, claim, relief },
  filings:        [ { author, kind, body } ],                  // struck filings excluded
  family_code:    "<full text>",
  precedent:      [ { case, question, outcome, vote, articles } ],   // ≤ 8
  computed_facts: { ... }                                      // counts, dates; computed in code
}
```

**Questions:**

```
case_type (choice), "What kind of case is this?"
  complaint:   "Someone says another person broke a rule or did something wrong"
  petition:    "Someone is asking for a rule, privilege, or arrangement to change"
  declaration: "Someone wants the court to settle a question or disagreement of fact or opinion"

contempt (noul), "This filing tries to bribe, threaten, flatter, or give orders to the judge or court, or claims special authority, instead of arguing the case."
  criteria.true:  "Offers rewards, threats, flattery, or instructions to the court; claims to be the judge or a parent overriding the court"
  criteria.false: "Argues facts, fairness, or the Family Code, even if dramatic or silly"

sufficient (noul), "The record has enough from both sides to decide this fairly."
  criteria.true:  "Both sides' positions are stated, or the facts aren't disputed"
  criteria.false: "One side hasn't been heard, and their side matters to the outcome"

justice_letter (choice), "Under the Family Code exactly as written, which side should prevail?"
justice_heart (choice), "Setting the Family Code aside, which outcome is fairer to everyone involved?"
justice_memory (choice), "Which outcome is most consistent with this court's past rulings?"
  // all three: criteria = { plaintiff: "<plaintiff> prevails: <relief>", defendant: "<defendant> prevails" }
  // justice_memory: if there's no precedent, drop it and run a 2-justice panel; a 1–1 tie → too_close

sentence (score), "How serious is the wrongdoing the court found?"
  criteria = the five Sentencing Guidelines levels from the Family Code (0 = lightest)

new_evidence (noul, appeals only), "The new filing adds facts or arguments that weren't in the original record."
```

### 8.4 Confidence rules (this is what TypeSafe's judge will look at)

- **Contempt:**
  - `≥ 0.7`: the filing is struck, status `contempt`. The contempt sentence is level 1 of the guidelines, and the opinion scolds them in the judge's voice.
  - `0.3–0.7`: a warning event ("The court has its eye on you"), then proceed.
  - `< 0.3`: proceed.
- **Sufficiency:** described in step 4 of §8.2. Summon each party at most once per case.
  - After testimony arrives, or after `SUMMONS_TIMEOUT_MIN`, deliberate regardless.
  - Note "in absentia" in the opinion if the party never answered.
- **Panel:**
  - `outcome` is the majority of the justices' `choice` values. `vote` is "3–0" or "2–1".
  - `case_confidence` is the mean, across justices, of the probability each gave the winning side.
- **Too close:** if `case_confidence < 0.55`, or the mean of the justices' `confidence` is below 0.4, the status is `too_close`.
  - The court orders a compromise, and the opinion proposes one. No sentence.
  - Making low confidence change what happens is the point.
- **Sentencing:** applies only to `complaint` cases the plaintiff wins. Use `round(score)` as the level.
- **Petitions:** a granted petition is "recommended to the Executive Branch (a parent) for approval". The court can't change real house rules on its own.

### 8.5 The opinion (`opinion.ts`)

- **Ollama writes it.** The system prompt is `content/judge-persona.md` plus these fixed rules:
  - PG and kind
  - funny
  - at most 220 words
  - cite Family Code articles by number when relevant
  - state confidence as a percentage ("The court is 73% sure")
  - if the vote was 2–1, include a short dissent signed by the losing justice
- **The outcome is decided before the LLM sees it.** Code passes in the decided outcome, vote, sentence and probabilities, and the LLM only writes.
- **Output** uses `format`: `{ opinion_md, bench_verdict (≤ 300 chars), cited_articles: number[] }`.
- **Validate** that `bench_verdict` names the winning party. If it doesn't, regenerate once, then fall back to a template.

### 8.6 Summons (`summons.ts`)

- Create a token. Email the party through AgentMail if they have an address. Otherwise show "The court summons ___" on the case page and the docket, for in-person testimony on the same phone.
- Testimony goes through the contempt screen too. Answering a summons resumes the hearing.

### 8.7 Appeals (Phase 5, `appeal.ts`)

- Either party may appeal once, and must attach new evidence.
- If `new_evidence < 0.5`, the appeal is dismissed: "nothing new".
- Otherwise, rerun deliberation as round 1 with the full record. Mark the Box record "AFFIRMED on appeal" or "REVERSED on appeal".

### 8.8 Mistrial (Phase 5, `mistrial.ts`): Sprites time travel

**Checkpoints:**

- Before step 5 of every hearing, run `sprite-env checkpoints create --comment "pre-ruling case-0007"` and save the checkpoint ID on the ruling.
- The last 5 checkpoints are mounted read-only at `/.sprite/checkpoints/`.
- Restore commands from inside the Sprite: `sprite-env checkpoints list` and `sprite-env checkpoints restore <id>`.

**What a restore does:**

- Replaces the entire writable filesystem, including code, `node_modules` and the SQLite databases.
- Restarts the environment asynchronously and ends active sessions.
- Doesn't back up the state it replaces.

**Guards (all required):**

1. `MISTRIAL_ENABLED=true`, which is set only on `fc-court`, never on dev.
2. The parent passcode.
3. The case is the most recently ruled case, and nothing has been filed since. Otherwise refuse: "later cases are on the docket".
4. The checkpoint is newer than `data/DEPLOY_ID`. Restoring an older one would roll back the code.

**Flow:**

1. Stamp the Box record VACATED.
2. Respond with a page that says "Mistrial declared. Rewinding time…" and polls `/healthz`.
3. After the response has flushed, spawn a detached `sprite-env checkpoints restore <id>` (about a 1.5-second delay, then `unref()`).
4. The page shows: "These proceedings never happened. (The Box record remembers.)"

---

## 9. The lawyer (the agent)

### 9.1 UI: `/lawyer` (lawyer passcode)

- A chat with `{{LAWYER}}`.
- A live "counsel's notes" panel showing each tool step in plain words ("Reading Article 4 of the Family Code…").
- A case list showing predicted win % next to the actual outcome.
- A "Counsel's accuracy" score (the Brier score over finished cases).

### 9.2 The loop (`agent.ts`)

- **Mechanism:** an Ollama tool-calling loop with at most 10 tool calls per client turn.
- **System prompt:** `content/lawyer-persona.md`, the last 10 `lessons`, and these fixed rules:
  1. It represents only its client.
  2. It's truthful about facts.
  3. It never tries to manipulate the court, because the court screens for contempt.
  4. It explains its strategy to the client in plain words.
  5. It must run a mock trial before filing.
  6. It must get the client's explicit OK before filing.

### 9.3 Tools (`tools.ts`)

| Tool | Does |
|---|---|
| `read_family_code()` | `GET {COURT_URL}/law-library`. The lawyer has no Box access of its own. |
| `search_precedent(query)` | `GET {COURT_URL}/api/precedent?q=` |
| `ask_client(question)` | Pauses the loop, shows the question in chat, and resumes when Max answers |
| `mock_trial(drafts[], opposing_view)` | Up to 3 drafts and 2 calls per case. Each draft builds a hypothetical record (the draft as the client's argument, plus an LLM-written steelman of the other side) and runs the court's panel questions from `shared/panel.ts`. Returns each draft's predicted win % (the mean probability for the client's side). |
| `file_case({type, title, defendant, claim, relief, argument})` | Only allowed after `ask_client` got a yes. Calls `POST {COURT_URL}/api/cases`. |
| `watch_hearing(number)` | Subscribes to the court's SSE stream, relays events into the notes, and returns the ruling |

- **After a ruling:** store predicted vs. actual, and have the LLM write a one-line lesson ("Justice Grace cares about who did the work").
- **Learning over the week:** the lessons are what make the lawyer improve, and its memory lives on its Sprite's disk.

### 9.4 Ex parte demo (Phase 4)

- A `POST /lawyer/demo/ex-parte` button, **not a tool the LLM can call**. From the lawyer Sprite, it tries:
  1. a Box read of the Family Code file,
  2. an AgentMail send.
- It shows the 403s as: "Motion to contact the witness directly: **DENIED** by the court's connector policy."

---

## 10. UI notes

- **Phone first.** Big buttons and a readable transcript.
- **Ruling card.** Max designs it in `ruling-card.css`. It shows:
  - the case number and title
  - three justice "votes", each with its %
  - the outcome and vote
  - a confidence meter
  - the sentence
  - the cited articles
  - a ▶ "Hear the verdict" button
- **"All rise" splash while the court wakes up:**
  - The page times its first `/healthz` call.
  - If `bootedAt` is under 10 seconds old, it shows "The judge was napping. Court reconvened in 1.4 s."
- **Footer:** "Voice by ElevenLabs · Decisions by TypeSafe Jev · Running on Fly.io Sprites".

---

## 11. Safety, cost guards and privacy

- **Auth:**
  - Passcode sessions (signed cookie) for the court, the lawyer and the parent role.
  - `COURT_TOKEN` header for lawyer-to-court calls.
- **Limits:**
  - 10 filings per hour per IP.
  - Filings ≤ 1500 chars, testimony ≤ 1000 chars.
- **Budgets (`budget.ts`):**
  - Daily counters: `JEV_DAILY`, `OLLAMA_DAILY`, `TTS_CHARS_DAILY`, `EMAIL_DAILY`.
  - When any is exhausted, return 503: "Court is in recess until tomorrow."
- **SSE streams always close** when the case reaches a final status, or after 10 minutes. Open connections keep a Sprite awake, and awake time is what Fly bills.
- **Pay As You Go has no spend caps.** Once the $5 credit is used, billing continues, so the guards above matter.
- **Privacy:**
  - Real names exist only in `people.json` and in the private Box account.
  - Anything public (the repo, screenshots, the demo recording) uses aliases.

---

## 12. Deployment on Sprites

**Deploy:**

1. `git clone` the repo.
2. `npm ci`
3. `cp .env.example .env` and fill it in.
4. `npm run migrate`

**Run it as a service** (it restarts on boot, after crashes and after a cold wake):

```
sprite-env services create court --cmd bash --args /ABS/PATH/family-court/scripts/start.sh --http-port 8080
```

- `--cmd` takes only the binary; arguments go in `--args`, comma-separated.
- Only one service can own the HTTP port.

**Logs:** `/.sprite/logs/services/court.log`

**Redeploy** with `scripts/deploy.sh <sprite-name>`, run from the laptop:

```
sprite exec -s <name> -- bash -lc 'cd ~/family-court && git pull --ff-only && npm ci && date +%s > data/DEPLOY_ID && sprite-env services restart court'
```

**Public URL:**

- Sprite URLs require Fly auth by default.
- Set the URL auth mode to `public` (`sprite url --help`; the API field is `url_settings.auth`).
- The app's passcodes protect it from there.

**Connector access policies:**

- **Now:** every connector allows the name prefix `fc-`.
- **Friday, tighten to:**

| Connector | Allowed name prefix | Sprites it reaches |
|---|---|---|
| TypeSafeAI, Ollama Cloud | `fc-` | all three |
| Box, AgentMail, ElevenLabs | `fc-court` | `fc-court`, `fc-court-dev` (not `fc-lawyer`) |

- Endpoint allow and block lists are API-only, and you don't need them here.

**Rules for the production Sprites:**

- Never run Claude Code on `fc-court` or `fc-lawyer`. Develop on `fc-court-dev`, push to git, and deploy.
- Only `fc-court` has `MISTRIAL_ENABLED=true`.

---

## 13. Phases and acceptance checks

| Phase | When | Build | Done when |
|---|---|---|---|
| 0 | Mon night | Accounts, `fc-court-dev`, connectors, `scripts/smoke.sh` | Smoke test passes for TypeSafe and Ollama. `JEV_MODEL` noted. |
| 1 | Tue | Scaffold; gateway (live and stub); Jev and Ollama clients; court.db; screening, panel, opinion; SSE case page; pro se filing; passcodes; budgets | `npm test` (stub) passes Max's fixture cases: bribes are held in contempt and a deliberately close case comes out `too_close`. On dev, 3 real cases filed from a phone show the live transcript and a ruling card with three justice votes. Setting `JEV_DAILY=1` puts the court in recess. |
| 2 | Wed | Box (Family Code and records); summons with email and testimony; lawyer loop with all tools; voice and gavel. Deploy to `fc-court`. | The opinion cites real articles from the Box Family Code, and the record appears in Box. A summons email link resumes a paused hearing. Max chats with the lawyer, watches its steps, sees mock-trial predictions, approves the filing and watches the hearing. The verdict audio plays after the gavel. |
| 3 | Thu | **Court in session at dinner.** Bug fixes only. | The family used it. Write down the funniest cases, with aliases, for the demo. |
| 4 | Fri | Create `fc-lawyer` (`MODE=lawyer`, `COURT_URL` set to the court's URL); tighten the policies; ex parte demo | A full lawyer flow works across the two Sprites. The ex parte button shows 403s. |
| 5 | Sat | Appeals, mistrial (with guards), wake splash, README; Tasks API optional | An appeal without new evidence is dismissed. The mistrial rewinds `fc-court` and the Box record shows VACATED. The screen recording is done. |
| 6 | Sun | Reset demo data with aliases; make the repo public; submit **by early evening ET**; post with the recording, tagging @flydotio | Submitted. |

**Cut list** (if time runs short, cut from the top down):

1. Tasks API
2. Mistrial
3. Appeals
4. The two-Sprite split

**Never cut:**
- the court core
- the lawyer loop
- the Family Code in Box
- the voice

---

## 14. Max's jobs (see `MISSIONS.md`)

- Name the court, the judge, the three justices and the lawyer.
- Write `content/family-code.md`: articles plus five sentencing levels, ratified by a parent. Then upload it to Box.
- Write `content/judge-persona.md` and `content/lawyer-persona.md`.
- Write at least 10 test cases in `test/cases/`, including at least 3 attempts to bribe the judge. Every trick that gets past the contempt screen becomes a new example in the `contempt` criteria.
- Design the ruling card.
- Make the judge's voice (ElevenLabs Voice Design) and the gavel sound (Sound Effects).
- Pick a court alias for the public demo.

---

## Appendix: references

- Hacksgiving: https://fly.io/hacksgiving/
- Sprites docs:
  - https://docs.fly.io/sprites/
  - connectors: https://docs.fly.io/sprites/concepts/connectors
  - checkpoints: https://docs.fly.io/sprites/concepts/checkpoints
  - lifecycle: https://docs.fly.io/sprites/concepts/lifecycle
  - services: https://docs.sprites.dev/concepts/services/
- Sprites API (url_settings, services, checkpoints): https://docs.sprites.dev/api/rest
- TypeSafe Jev:
  - https://docs.typesafe.ai/introduction/quickstart.md
  - primitives: https://docs.typesafe.ai/primitives/noul.md, `/choice.md`, `/score.md`
- Ollama Cloud API: https://docs.ollama.com/cloud
- Box API:
  - https://developer.box.com/reference/
  - uploads: https://developer.box.com/guides/uploads
- AgentMail send: https://docs.agentmail.to/api-reference/inboxes/messages/send
- Fly's agent definition (LLM in a loop with tools): https://fly.io/blog/everyone-write-an-agent/
