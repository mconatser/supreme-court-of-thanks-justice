# Release checklist (Sunday, Nov 29)

Work through this top to bottom before the repo goes public. Submissions close at midnight PST; aim to submit by early evening ET.

## 1. Privacy: before the repo goes public

- [ ] **Replace Max's real name with his court alias everywhere in the repo.** Find every occurrence with `git grep -n -i Max` (and check for any other family names the same way). As of Phase 1 it appears in:
  - `SPEC.md` (about 15 times), `SETUP.md` (4), `MISSIONS.md` (1)
  - code comments and placeholder notes: `public/css/ruling-card.css`, `src/court/familyCode.ts`, `src/shared/cast.ts`, `test/cases.test.ts`, `test/familyCode.test.ts`
  - the `_placeholder` notes in `test/cases/example-*.json` (if those files still exist by Sunday)
  - the filename `MISSIONS.md` itself: rename it (for example `LAWMAKER.md`) and update links to it
- [ ] **Clean the git history.** Earlier commits still contain the name after the files are fixed. Either publish a fresh repo from a single squashed commit, or rewrite history (for example with `git filter-repo --replace-text`) before making it public. Then run `git log -p | grep -i Max` and check that it prints nothing.
- [ ] Check that `data/`, `.env` and `people.json` were never committed: `git log --all --oneline -- data .env people.json` should print nothing.
- [ ] Scan the repo for real names, emails and Box/AgentMail IDs from `people.json` and `.env`.
- [ ] Demo data, screenshots and the screen recording use court aliases only.

## 2. Demo data

- [ ] Reset the demo data with aliases (SPEC §13, Phase 6).

## 3. Docs match what shipped

- [ ] README.md: every feature it describes works on `fc-court` and `fc-lawyer`. If the mistrial, appeals or the two-Sprite split were cut, remove them from the README pitch and diagram.
- [ ] Add screenshots or a GIF of the ruling card, the lawyer's mock trial, and the ex parte 403.

## 4. Submit

- [ ] Make the repo public.
- [ ] Submit: code link, demo, short description (SPEC §1), by early evening ET.
- [ ] Post with the recording, tagging @flydotio.

## 5. After the hackathon

- [ ] Delete `fc-court-dev` (or all three Sprites if you're done), per SETUP.md's cost guardrails.
