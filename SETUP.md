# Tonight's setup (Phase 0)

Goal for tonight: one Sprite running, every connector answering, and a real Jev ruling on "Is a hot dog a sandwich?"

You (Mark) own every account. Max is under 13, so he works alongside you on yours.

---

## 1. Accounts (about 30 min)

Do TypeSafe first. Everything depends on it.

- [ ] **TypeSafe.**
  - Sign up at console.typesafe.ai and create an API key.
  - Reports from September disagree about whether new accounts get free credit. Either way, Jev costs fractions of a cent per ruling.
  - If signup is blocked, stop and tell Claude. The plan needs a fallback.
- [ ] **Fly.io.**
  - Log in and switch to the **Free** plan. It gives $5 of usage a month and up to 3 Sprites, and it needs a card.
  - Note: after $5 it moves to Pay As You Go, which has no spend cap. The app's daily budgets are the guardrail.
- [ ] **Ollama.**
  - Create an API key at ollama.com/settings/keys.
  - Browse ollama.com/search?c=cloud and pick a **tool-calling** model. Prefer a cheaper or starter model.
  - Add about $5 of pay-as-you-go credit only if the free allowance runs out. Skip the $20 plan.
- [ ] **Box.**
  - Create a free personal account.
  - Create a folder `Family Court` with a subfolder `Court Records`.
  - Upload `content/family-code.md` (the template, for now).
  - Copy the IDs from the URLs:
    - the folder ID is the number at the end of `app.box.com/folder/<id>`
    - the file ID is the number at the end of `app.box.com/file/<id>`
- [ ] **AgentMail.**
  - Create a free account and an API key.
  - Create the clerk's inbox, either in the console or with `POST https://api.agentmail.to/v0/inboxes` and a `display_name` such as "Clerk of the Court".
  - Save the `inbox_id`.
- [ ] **ElevenLabs.**
  - Create a free account (10k credits a month, about 10 minutes of speech).
  - Max designs the voice on Wednesday. Nothing else is needed tonight.

## 2. Sprite CLI and the dev Sprite (about 10 min)

```bash
curl -fsSL https://sprites.dev/install.sh | sh
sprite login
sprite create fc-court-dev
sprite use fc-court-dev
```

Open a shell on it with `sprite console`. For one-off commands, use `sprite exec -- <cmd>`. If either command doesn't work, check `sprite --help`.

Create **only** `fc-court-dev` tonight:
- `fc-court` gets created on Wednesday.
- `fc-lawyer` gets created on Friday.
- The free plan allows 3 Sprites in total.

## 3. Connectors (about 15 min)

In the Fly dashboard, go to **Sprites → Connectors → Add connector** and add these five:

| Connector | Credential |
|---|---|
| TypeSafeAI | TypeSafe API key |
| Ollama Cloud | Ollama API key |
| Box | Box account. It needs read and write permission, even for downloads. |
| AgentMail | AgentMail API key |
| ElevenLabs | ElevenLabs API key. Check which paths it forwards. If text to speech isn't among them, add a **Custom API** connector for `https://api.elevenlabs.io` that sends the key in the `xi-api-key` header. |

For **each** connector, open its access settings:
1. Turn off "Allow all sprites".
2. Set **name prefix = `fc-`**.

A connector with no access policy denies everything (403). You'll tighten Box, AgentMail and ElevenLabs on Friday.

## 4. Smoke test, run inside the Sprite (about 5 min)

```bash
# inside fc-court-dev (sprite console)
git clone <your repo> family-court && cd family-court     # or copy scripts/smoke.sh over
export OLLAMA_MODEL=<model you picked>
export BOX_FOLDER_ID=<Family Court folder id>
bash scripts/smoke.sh
```

**What to expect:**
- Section 1 lists each connector's gateway URL and usage snippet.
- Then you get one PASS or FAIL per connector.

**If something fails:**

| Result | Meaning |
|---|---|
| 401 | You're not inside a Sprite |
| 403 | The access policy doesn't include this Sprite's name |
| 404 | The path isn't forwarded. Compare it with the connector's usage snippet. |

- If auto-discovery picks the wrong connector, set the `*_BASE` overrides (see `.env.example`).
- Copy the `"model"` value from the Jev response into `.env` as `JEV_MODEL` (for example `jev-1.14.0`) once you've tuned the thresholds.

**Tonight's minimum:** TypeSafe and Ollama pass. Box, AgentMail and ElevenLabs can wait until Wednesday if they fight you.

## 5. Repo and Claude Code (about 5 min)

1. Create a **private** GitHub repo, `family-court`. Make it public on Sunday.
2. Commit this starter.
3. Clone it on `fc-court-dev`.
4. Make `.env` from `.env.example`. Generate `COURT_TOKEN` and `SESSION_SECRET` with `openssl rand -hex 32`.
5. Create `people.json` (gitignored; the format is in SPEC.md section 5).
6. Start Claude Code on the Sprite. Every Sprite ships with it; sign in with your subscription.

**First prompt:**

> Read SPEC.md end to end, then /.sprite/llm.txt and /.sprite/llm-dev.txt. Run `bash scripts/smoke.sh` and show me the output. Then propose your Phase 1 plan (files, dependencies, test approach) and wait for my OK before writing any code.

**Optional:** to manage Sprites from Claude Code on your laptop, run
`claude mcp add --transport http sprites https://sprites.dev/mcp`.

## 6. Max's homework for Tuesday

Hand him `MISSIONS.md`. On Tuesday, the court needs:
- a Family Code draft (at least 5 articles and the 5 sentencing levels),
- the judge persona,
- and at least 10 test cases.

## Cost guardrails (keep these in mind all week)

- **Sleeping Sprites cost almost nothing.** Idle Sprites only pay for stored data, and Fly only bills compute while a Sprite is awake.
- **Watch the dev Sprite.** Long Claude Code sessions on `fc-court-dev` are the main Fly cost, and probably still only a dollar or two for the week.
- **Close the tab** on a live hearing page when you're done. Open connections keep the court awake.
- **Check usage** in the Fly dashboard on Wednesday and Saturday.
- **After Sunday:** delete `fc-court-dev`, or all three Sprites if you're done.
