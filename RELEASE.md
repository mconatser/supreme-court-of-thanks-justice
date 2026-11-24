# Release checklist (Wednesday night, Nov 25)

Work through this top to bottom on Wednesday night, before the repo goes public. We're releasing early: the hackathon itself closes at midnight PST on Sunday, Nov 29.

## 1. Privacy: before the repo goes public

Nothing private is written in this repo's tracked files, not even in the tools. The names, family emails and private words live only in gitignored files: `people.json`, `.private-terms` (extra words, plus `allow:` lines for the entrant's own name), and `.release-scrub.local` (the release author identity and file renames).

- [ ] **Audit.** Run `python3 scripts/audit-private.py repo`. It checks every tracked file, every old version of every file, every commit message, and every author and committer. It prints labels and masked matches, never the words. Also run it on each Sprite's data (`data DIR`, see the script's help).
- [ ] **Set the release author.** In `.release-scrub.local`, set `author:` to your GitHub noreply address (github.com/settings/emails → "Keep my email addresses private"). The scrub refuses a family email address.
- [ ] **Scrub the whole history, keeping every commit and its dates.** The history is the evidence that the project was built during the week, so don't squash it.
  0. The new public repo is `mconatser/supreme-court-of-thanks-justice`. Every step below passes it as `--public-repo`; the scrub points the clone URLs in `FC_COURT_SETUP.md` and `FC_LAWYER_SETUP.md` (and any other link to this private repo) at it.
  1. `scripts/release-scrub.sh --public-repo mconatser/supreme-court-of-thanks-justice`: a dry run. It scrubs a throwaway clone (every real name becomes its alias, family emails become `[email removed]`, private words are replaced, the missions file is renamed, every identity becomes the release author), then runs the same audit on the result. It must say "clean".
  2. `scripts/release-scrub.sh --public-repo mconatser/supreme-court-of-thanks-justice --apply` writes the scrubbed repo (master only, no tags) to `../family-court-release`. It doesn't push.
  3. Create a **new, empty public repo** on GitHub (no README, license or .gitignore), and push the scrubbed master to it, master only, no tags: `git remote add public https://github.com/mconatser/supreme-court-of-thanks-justice.git && git push public master` (the scrub prints the exact commands). No force-push: this private repo is never rewritten or made public, and the Sprites keep deploying from it.
  4. Check the new repo on GitHub before sharing the link: search it for the names, and look at a few old commits. Their dates should fall between Nov 23 and Nov 25, during Hacksgiving week.
- [ ] **What the scrub can't reach:** text inside images and audio (check the screenshots by eye), and the private data in Box, AgentMail, ElevenLabs and the Sprites themselves. The unscrubbed history stays in this private repo, which is never made public.
- [ ] Check that `data/`, `.env`, `people.json` and the two private files were never committed: `git log --all --oneline -- data .env people.json .private-terms .release-scrub.local` should print nothing.
- [ ] Demo data, screenshots and the screen recording use court aliases only.

## 2. Demo data

- [ ] Reset the demo data (SPEC §13, Phase 6), on `fc-court` and `fc-court-dev`: `bash scripts/demo-reset.sh` (dry run), then `bash scripts/demo-reset.sh --apply`. It also renames every `people.json` id to its alias (ids can be real first names). Reset `fc-lawyer` at the same time (`SERVICE=lawyer bash scripts/demo-reset.sh --apply`): its memory refers to the old case numbers. Check the docket, then delete the `data/backup-*` folder it prints. It backs up and clears `court.db`, `lawyer.db` and the cached audio into `data/backup-<time>/`. Move old Box records aside first if the new #0001 shouldn't become a version of an old record.

## 3. Docs match what shipped

- [ ] README.md: every feature it describes works on `fc-court` and `fc-lawyer`. If the mistrial, appeals or the two-Sprite split were cut, remove them from the README pitch and diagram.
- [ ] Add screenshots or a GIF of the ruling card, the lawyer's mock trial, and the ex parte 403.

## 4. Submit

- [ ] Publish the scrubbed repo as the new public repo (§1).
- [ ] Submit with the new public repo's link (not this private one).
- [ ] Submit on Wednesday night: code link, demo, short description (SPEC §1).
- [ ] Post with the recording, tagging @flydotio.

## 5. After the hackathon

- [ ] Delete `fc-court-dev` (or all three Sprites if you're done), per SETUP.md's cost guardrails.
