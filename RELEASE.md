# Release checklist (Wednesday night, Nov 25)

Work through this top to bottom on Wednesday night, before the repo goes public. We're releasing early: the hackathon itself closes at midnight PST on Sunday, Nov 29.

## 1. Privacy: before the repo goes public

- [ ] **Replace Max's real name with his court alias everywhere in the repo.** Find every occurrence with `git grep -n -i Max` (and check for any other family names the same way). As of Phase 1 it appears in:
  - `SPEC.md` (about 15 times), `SETUP.md` (4), `MISSIONS.md` (1)
  - code comments and placeholder notes: `public/css/ruling-card.css`, `src/court/familyCode.ts`, `src/shared/cast.ts`, `test/cases.test.ts`, `test/familyCode.test.ts`
  - the `_placeholder` notes in `test/cases/example-*.json` (if those files still exist on Wednesday)
  - the filename `MISSIONS.md` itself: rename it (for example `LAWMAKER.md`) and update links to it
- [ ] **Scrub the whole history, keeping every commit and its dates.** The history is the evidence that the project was built during the week, so don't squash it. `scripts/release-scrub.sh` uses `git filter-repo --replace-text` (contents and commit messages), `--path-rename` and a mailmap (every commit becomes `Mark [redacted] <[email removed]>`). It works on a fresh clone, never on this working copy:
  1. `scripts/release-scrub.sh --alias "<Max's court alias>"`. This is a dry run that only prints the report: commit count, identical dates, name mentions before and after (must be 0 after), authors, that `MISSIONS.md` was renamed, that `.env`, `people.json` and `data/` were never committed, and that no other `people.json` names or emails appear.
  2. When the report is clean: `scripts/release-scrub.sh --alias "<alias>" --apply` writes the scrubbed repo to `../family-court-release`. It doesn't push.
  3. Follow the printed steps: force-push from there, then `git fetch && git reset --hard origin/master` on every Sprite clone. `deploy.sh`'s `git pull --ff-only` refuses rewritten history.
  4. Check on GitHub: search the repo for the name and look at a few old commits. Their dates should fall between Nov 23 and Nov 25, during Hacksgiving week.
- [ ] Check that `data/`, `.env` and `people.json` were never committed: `git log --all --oneline -- data .env people.json` should print nothing.
- [ ] Scan the repo for real names, emails and Box/AgentMail IDs from `people.json` and `.env`.
- [ ] Demo data, screenshots and the screen recording use court aliases only.

## 2. Demo data

- [ ] Reset the demo data with aliases (SPEC §13, Phase 6): inside `fc-court`, run `bash scripts/demo-reset.sh` (dry run), then `bash scripts/demo-reset.sh --apply`. It backs up and clears `court.db`, `lawyer.db` and the cached audio into `data/backup-<time>/`. Move old Box records aside first if the new #0001 shouldn't become a version of an old record.

## 3. Docs match what shipped

- [ ] README.md: every feature it describes works on `fc-court` and `fc-lawyer`. If the mistrial, appeals or the two-Sprite split were cut, remove them from the README pitch and diagram.
- [ ] Add screenshots or a GIF of the ruling card, the lawyer's mock trial, and the ex parte 403.

## 4. Submit

- [ ] Make the repo public.
- [ ] Submit on Wednesday night: code link, demo, short description (SPEC §1).
- [ ] Post with the recording, tagging @flydotio.

## 5. After the hackathon

- [ ] Delete `fc-court-dev` (or all three Sprites if you're done), per SETUP.md's cost guardrails.
