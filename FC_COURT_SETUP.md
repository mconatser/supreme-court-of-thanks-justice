# Setting up `fc-court` (production courthouse)

Run these **from your laptop** unless a step says otherwise. Never run Claude Code on `fc-court`: develop on `fc-court-dev`, push, then deploy.

Allow about 20 minutes. Afterwards, redeploys are one command: `scripts/deploy.sh fc-court`.

## 0. Before you start

- [ ] **Push the code.** The Sprite pulls from GitHub: `git push origin master`.
- [ ] **Give dev its own Box records folder.** Dev and prod would otherwise share `Court Records`, which already holds `Case-0001.md` to `Case-0008.md` from testing. A fresh `fc-court` numbers its cases from #1 again, and its first record would land on top of dev's `Case-0001.md` as a new version.
  1. In Box, create `Family Court/Court Records (dev)` and move the dev records into it.
  2. On `fc-court-dev`, set `BOX_RECORDS_FOLDER_ID` in `.env` to the new folder's id, then run `sprite-env services restart court`.
  3. `fc-court` keeps using the real `Court Records` folder.
- [ ] **Split the voice budget.** Each Sprite counts `TTS_CHARS_DAILY` separately, and both draw from the same ElevenLabs free plan (about 10 minutes a month). Set dev's `TTS_CHARS_DAILY` to something small, such as `500`.

## 1. Create the Sprite

```bash
sprite create fc-court
```

The connectors' current access policy (name prefix `fc-`) already covers `fc-court`.

## 2. Get the code onto it

The repo stays private until the release on Wednesday night, so the Sprite needs read access to GitHub. Open a shell on it:

```bash
sprite console -s fc-court
```

Then, **inside the Sprite**:

```bash
gh auth login        # if gh is installed; otherwise use a read-only fine-grained token for git clone
git clone https://github.com/mconatser/supreme-court-of-thanks-justice.git ~/family-court
cd ~/family-court
npm ci
node -e "require('better-sqlite3')(':memory:'); console.log('better-sqlite3 OK on', process.arch)"
```

better-sqlite3 ships prebuilt binaries for x64 and arm64 (glibc and musl), so `npm ci` needs no build tools. If that check fails, stop and tell Claude.

## 3. Secrets and the family list

Still inside the Sprite, create `~/family-court/.env` and `~/family-court/people.json`. Both are gitignored. The easiest way is to open `nano .env` and paste.

Start from dev's `.env`. You can print it on your laptop with `sprite exec -s fc-court-dev -- bash -lc "cat ~/family-court/.env"`. Then change these values:

| Key | On `fc-court` |
|---|---|
| `PUBLIC_BASE_URL` | `fc-court`'s URL (find it with `sprite info -s fc-court`) |
| `COURT_URL` | `http://localhost:8080` (Phase 4 points `fc-lawyer` at the public URL) |
| `SESSION_SECRET` | a new one: `openssl rand -hex 32` |
| `BOX_RECORDS_FOLDER_ID` | the real `Court Records` folder (not the dev one) |
| `TTS_CHARS_DAILY` | `3000` |
| `MISTRIAL_ENABLED` | `false` for now (Phase 5 turns it on, on `fc-court` only) |

Keep these the same as dev: `COURT_TOKEN`, the passcodes, `JEV_MODEL=jev-1.14.0`, `OLLAMA_MODEL`, the Box Family Code file id, the AgentMail inbox, `ELEVENLABS_BASE` and the voice and model ids.

Copy `people.json` as is. Every person needs an alias, and the court refuses to start without them.

## 4. Database, service, URL

Inside the Sprite:

```bash
cd ~/family-court
npm run migrate
date +%s > data/DEPLOY_ID
sprite-env services create court --cmd bash --args /home/sprite/family-court/scripts/start.sh --http-port 8080
curl -s localhost:8080/healthz
bash scripts/smoke.sh          # every connector should PASS (it reads .env)
exit
```

Back on your laptop:

```bash
sprite config update -s fc-court --url-auth public    # the passcodes protect it from here
```

## 5. Check it end to end

On your phone, open `fc-court`'s URL and:

- [ ] Log in with the court passcode and see an empty docket. A fresh court starts at Case #0001.
- [ ] File a case that resembles one of Max's landmarks. Justice Jack should vote and cite it.
- [ ] Check that the record appears in Box under `Court Records` and the verdict plays after the gavel.
- [ ] File a one-sided case. A summons should go out (by email if the person has one), and answering it should resume the hearing.

Then take a checkpoint inside the Sprite:

```bash
sprite exec -s fc-court -- sprite-env checkpoints create --comment "fc-court: first deploy"
```

## Turning on mistrials (fc-court only)

1. On `fc-court`, set `MISTRIAL_ENABLED=true` in `.env`, then run `sprite-env services restart court`. Never turn it on for dev: a restore would end the Claude Code session there.
2. Redeploy once (`scripts/deploy.sh fc-court`) so `data/DEPLOY_ID` is fresh. Checkpoints older than the last deploy are refused, because restoring one would roll back the code.
3. To try it, file and rule a case. The transcript shows "The clerk saves a copy of the whole courthouse". Then, logged in with the **parent** passcode, press **Declare a mistrial**. The record in Box gets a VACATED version, the courthouse rewinds and restarts (about 10–30 s), and the case comes back as vacated: "These proceedings never happened. (The Box record remembers.)"
4. Guards: the court refuses if a later case was filed, if the checkpoint was pruned (only the last few are kept), if it's older than the deploy, or if Box can't take the VACATED record.

## Redeploying

```bash
git push origin master
scripts/deploy.sh fc-court
```

The script pulls, runs `npm ci`, checks that SQLite loads, migrates, updates `data/DEPLOY_ID`, restarts the service and waits for `/healthz`.

## Later: the lawyer's own Sprite

See [FC_LAWYER_SETUP.md](FC_LAWYER_SETUP.md). It also covers tightening the connector policies.

## Tightening connector access (SPEC §12)

The official ElevenLabs connector isn't used. Text to speech goes through the **Custom API connector** (`elevenlabs-tts`), and that connector needs its own policy too:

| Connector | Allowed name prefix |
|---|---|
| TypeSafeAI, Ollama | `fc-` |
| Box, AgentMail, **Custom API (elevenlabs-tts)**, ElevenLabs | `fc-court` |

## Logs and trouble

- Service log: `sprite exec -s fc-court -- tail -n 100 /.sprite/logs/services/court.log`
- `401` from a connector means the call wasn't made from inside a Sprite. `403` means the access policy doesn't match the Sprite's name.
- The court resumes interrupted hearings and files any missing Box records on boot.
