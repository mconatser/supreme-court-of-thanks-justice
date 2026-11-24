# Setting up `fc-lawyer` (the lawyer, on its own Sprite)

The lawyer moves off the courthouse onto its own Sprite and talks to the court only over HTTPS, using the `COURT_TOKEN` header. Then the connector policies are tightened so the court's tools (Box, email, the judge's voice) answer only to the courthouse. That's the separation of powers, and the ex parte button proves it with a 403.

`fc-court` must already be running (see [FC_COURT_SETUP.md](FC_COURT_SETUP.md)). Run these steps from your laptop unless a step says otherwise.

## 1. Create the Sprite and get the code

```bash
git push origin master
sprite create fc-lawyer
sprite console -s fc-lawyer
```

Then, **inside the Sprite**:

```bash
gh auth login
git clone https://github.com/mconatser/supreme-court-of-thanks-justice.git ~/family-court
cd ~/family-court && npm ci
node -e "require('better-sqlite3')(':memory:'); console.log('better-sqlite3 OK on', process.arch)"
```

## 2. `.env` (no `people.json` needed: the lawyer gets the party list from the court)

Create the file with `nano ~/family-court/.env`:

| Key | Value |
|---|---|
| `MODE` | `lawyer` |
| `PORT` | `8080` |
| `PUBLIC_BASE_URL` | `fc-lawyer`'s URL |
| `GATEWAY_MODE` | `live` |
| `COURT_URL` | `fc-court`'s public URL, e.g. `https://fc-court-<org>.sprites.app` |
| `COURT_TOKEN` | **the same value as on `fc-court`** |
| `LAWYER_PASSCODE` | the lawyer passcode |
| `SESSION_SECRET` | a new one: `openssl rand -hex 32` |
| `LAWYER_CLIENT` | Max's court alias, exactly as in `fc-court`'s `people.json` |
| `JEV_MODEL`, `OLLAMA_MODEL` | same as the court (`jev-1.14.0`, `glm-5.3-flash`) |
| `JEV_DAILY`, `OLLAMA_DAILY` | the lawyer's own daily budgets (e.g. `300` and `150`) |
| `COURT_TZ` | same as the court |

**For the ex parte demo only.** These give the button something to try, and to be refused. Copy them from `fc-court`'s `.env`: `BOX_FAMILY_CODE_FILE_ID`, `AGENTMAIL_INBOX_ID`, `ELEVENLABS_BASE`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`. They're ids, not secrets. The connectors hold the keys, and once the policies are tightened they refuse this Sprite anyway.

`COURT_PASSCODE` and `PARENT_PASSCODE` aren't needed here.

## 3. Service and URL

Inside the Sprite:

```bash
cd ~/family-court
mkdir -p data && date +%s > data/DEPLOY_ID
sprite-env services create lawyer --cmd bash --args /home/sprite/family-court/scripts/start.sh --http-port 8080
curl -s localhost:8080/healthz
exit
```

On your laptop:

```bash
sprite config update -s fc-lawyer --url-auth public
```

Open `fc-lawyer`'s URL, enter the lawyer passcode, and say hello to counsel.

## 4. Tighten the connector policies (Fly dashboard → Sprites → Connectors)

For each connector, open its access settings and set the name prefix:

| Connector | Allowed name prefix | Sprites it reaches |
|---|---|---|
| TypeSafeAI | `fc-` | all three |
| Ollama | `fc-` | all three |
| Box | `fc-court` | `fc-court`, `fc-court-dev` |
| AgentMail | `fc-court` | `fc-court`, `fc-court-dev` |
| **Custom API (elevenlabs-tts)** | `fc-court` | `fc-court`, `fc-court-dev` |
| ElevenLabs (official, unused) | `fc-court` | `fc-court`, `fc-court-dev` |

## 5. Check the split

- [ ] On `fc-lawyer`, press **⚖️ Motion to contact the witness directly**. All three attempts should say **DENIED**, under "Motion to contact the witness directly: DENIED by the court's connector policy." If any say ALLOWED, that connector's prefix is still `fc-`.
- [ ] Run a full lawyer case from `fc-lawyer`: interview, mock trial, Yes, file, watch. The case appears on `fc-court`'s docket as filed by counsel, and the lawyer's notes show the hearing live.
- [ ] Run `bash scripts/smoke.sh` on `fc-court`. Everything should still pass there.
- [ ] Take a checkpoint: `sprite exec -s fc-lawyer -- sprite-env checkpoints create --comment "fc-lawyer: split done"`.

## 6. Make `fc-court` courthouse-only

Once `fc-lawyer` works, the only lawyer should be on `fc-lawyer`. On `fc-court`, edit `~/family-court/.env`:

| Key | Change |
|---|---|
| `MODE` | `all` → `court` |
| `LAWYER_URL` | add `https://fc-lawyer-wc3u.sprites.app` (`fc-court`'s `/lawyer` redirects there) |
| `LAWYER_CLIENT` | can go: nothing on `fc-court` uses it now |

Leave everything else alone. `COURT_TOKEN` must still match `fc-lawyer`'s, and `LAWYER_PASSCODE` can stay. Then restart (or redeploy):

```bash
sprite exec -s fc-court -- sprite-env services restart court
```

Check it:
- [ ] The log says `no lawyer here; /lawyer redirects to https://fc-lawyer-wc3u.sprites.app`.
- [ ] Opening `fc-court`'s `/lawyer` lands on `fc-lawyer`.

`fc-court`'s old `data/lawyer.db` stays on disk, unused. Cases filed by the old in-court lawyer before the switch keep their court records, but `fc-lawyer` doesn't track their predictions.

## Redeploying

```bash
git push origin master
SERVICE=lawyer scripts/deploy.sh fc-lawyer
```
