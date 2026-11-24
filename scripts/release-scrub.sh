#!/usr/bin/env bash
# Release prep: scrub a real name from the WHOLE git history (contents, file names, commit
# messages) and fix authorship with a mailmap, keeping every commit and its dates. The history is
# our evidence that the project was built during Hacksgiving week, so nothing is squashed.
#
#   scripts/release-scrub.sh --alias "Pip"                 # dry run (default): report only
#   scripts/release-scrub.sh --alias "Pip" --apply         # write the scrubbed repo to --out
#
# Options:
#   --alias TEXT      the public court alias that replaces the name (required)
#   --name TEXT       the name to scrub (default: Max; matched case-insensitively, whole word)
#   --rename A:B      also rename a file across history (default: MISSIONS.md:LAWMAKER.md)
#   --author "N <E>"  the identity every commit is attributed to (default: Mark [redacted] <[email removed]>)
#   --out DIR         where --apply writes the scrubbed clone (default: ../family-court-release)
#   --apply           actually produce the scrubbed clone (still never pushes)
#
# Both modes work on a fresh clone; this working copy is never rewritten. Needs git-filter-repo
# (uv tool install git-filter-repo==2.47.0, or pip install git-filter-repo).
set -euo pipefail

NAME="Max"
ALIAS=""
RENAME="MISSIONS.md:LAWMAKER.md"
AUTHOR="Mark [redacted] <[email removed]>"
OUT=""
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --alias) ALIAS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --rename) RENAME="$2"; shift 2 ;;
    --author) AUTHOR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
die() { echo "release-scrub: $*" >&2; exit 1; }

[ -n "$ALIAS" ] || die "--alias is required (the court alias that replaces \"$NAME\")."
if echo "$ALIAS" | grep -qi "\b$NAME\b"; then die "the alias can't contain the name itself."; fi
[[ "$AUTHOR" =~ ^[^\<]+\ \<[^\>]+@[^\>]+\>$ ]] || die "--author must look like 'Name <email>'."
command -v git-filter-repo >/dev/null || die "git-filter-repo isn't installed (uv tool install git-filter-repo==2.47.0)."
[ -z "$(git status --porcelain)" ] || die "commit or stash your changes first (the scrub works on what's committed)."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$APPLY" = 1 ]; then
  OUT="${OUT:-$(dirname "$REPO")/family-court-release}"
  [ ! -e "$OUT" ] || die "$OUT already exists; remove it or pass --out."
  WORK="$OUT"
else
  WORK="$(mktemp -d)/family-court-scrub"
fi
RULES="$(mktemp -d)"
trap 'rm -rf "$RULES"; [ "$APPLY" = 1 ] || rm -rf "$(dirname "$WORK")"' EXIT

FROM="${RENAME%%:*}"
TO="${RENAME##*:}"
python3 - "$NAME" "$ALIAS" "$FROM" "$TO" "$AUTHOR" "$RULES" <<'PY'
import re, sys
name, alias, frm, to, author, out = sys.argv[1:]
lines = []
if frm and to and frm != to:
    lines.append(f"regex:\\b{re.escape(frm)}\\b==>{to}")       # links to the renamed file first
lines.append(f"regex:(?i)\\b{re.escape(name)}\\b==>{alias}")    # then every remaining mention
open(f"{out}/replacements.txt", "w").write("\n".join(lines) + "\n")
# Map every identity seen in history to the release author.
open(f"{out}/mailmap", "w").write(
    f"{author} Sprite <noreply@sprites.dev>\n"
    f"{author} <mconatser@obviyo.com>\n"
)
PY

echo "== Release scrub ($([ "$APPLY" = 1 ] && echo APPLY || echo DRY RUN)): \"$NAME\" → \"$ALIAS\", $FROM → $TO, authors → $AUTHOR"
git clone --quiet --no-local --branch "$BRANCH" "$REPO" "$WORK"
cd "$WORK"

count_hits() { # whole history: file contents, file names, commit messages and identities
  { git log --all -p --format='%an %ae %cn %ce%n%B' ; git log --all --name-only --format=; } | grep -ciw -- "$NAME" || true
}
BEFORE_HITS="$(count_hits)"
BEFORE_DATES="$(git log --reverse --format='%aI %cI')"
BEFORE_COUNT="$(git rev-list --count HEAD)"

ARGS=(--force --replace-text "$RULES/replacements.txt" --replace-message "$RULES/replacements.txt" --mailmap "$RULES/mailmap")
if [ -n "$FROM" ] && [ "$FROM" != "$TO" ]; then ARGS+=(--path-rename "$FROM:$TO"); fi
git filter-repo "${ARGS[@]}" >/dev/null

AFTER_HITS="$(count_hits)"
AFTER_DATES="$(git log --reverse --format='%aI %cI')"
AFTER_COUNT="$(git rev-list --count HEAD)"

OK=1
echo
echo "Commits:              $BEFORE_COUNT before, $AFTER_COUNT after"
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] || { echo "  !! commit count changed"; OK=0; }
if [ "$BEFORE_DATES" = "$AFTER_DATES" ]; then
  echo "Dates:                identical (author and committer, every commit)"
  echo "                      first $(echo "$AFTER_DATES" | head -1 | cut -d' ' -f1), last $(echo "$AFTER_DATES" | tail -1 | cut -d' ' -f1)"
else
  echo "  !! commit dates changed"; OK=0
fi
echo "Mentions of \"$NAME\":  $BEFORE_HITS before, $AFTER_HITS after (contents, file names, messages, identities)"
[ "$AFTER_HITS" = 0 ] || { echo "  !! some remain:"; git log --all -p --format='%h %s' | grep -niw -- "$NAME" | head -5; OK=0; }
echo "Authors after:"
git log --all --format='  %an <%ae>' | sort | uniq -c
echo "Committers after:"
git log --all --format='  %cn <%ce>' | sort | uniq -c
if [ -n "$(git ls-files "$FROM")" ]; then echo "  !! $FROM still exists"; OK=0; fi
[ -z "$TO" ] || [ -n "$(git ls-files "$TO")" ] && echo "Renamed:              $FROM → $TO" || true

SENSITIVE="$(git log --all --format='%h' -- .env people.json data | head -1)"
if [ -n "$SENSITIVE" ]; then echo "  !! .env, people.json or data/ appear in history (commit $SENSITIVE)"; OK=0; else echo "Never committed:      .env, people.json, data/"; fi

# Real names, emails and aliases from people.json (counts only, never printed).
if [ -f "$REPO/people.json" ]; then
  PRIVATE="$(python3 - "$REPO/people.json" "$NAME" "$AUTHOR" <<'PY'
import json, re, subprocess, sys
people = json.load(open(sys.argv[1])); scrubbed = sys.argv[2].lower(); author = sys.argv[3].lower()
# The release author's own name and email are meant to be public (they sign every commit).
own = set(re.findall(r"[^\s<>]+", author)) | {author.split(" <")[0], author.split("<")[-1].rstrip(">")}
terms = {t.strip().lower() for p in people for t in (p.get("name", ""), p.get("email", "")) if len(t.strip()) >= 3}
terms = {t for t in terms if t != scrubbed and t not in own}
text = subprocess.run(["git", "log", "--all", "-p", "--format=%an %ae %cn %ce%n%B"], capture_output=True, text=True).stdout.lower()
print(sum(1 for t in terms if re.search(r"\b" + re.escape(t) + r"\b", text)))
PY
)"
  if [ "$PRIVATE" = 0 ]; then echo "people.json names/emails in history: none (other than the release author's own)"; else echo "  !! $PRIVATE real name(s)/email(s) from people.json still appear in history"; OK=0; fi
fi

echo
if [ "$OK" != 1 ]; then echo "Problems found. Nothing was pushed."; exit 1; fi
if [ "$APPLY" = 1 ]; then
  cat <<EOF
The scrubbed repo is ready at: $WORK
Nothing has been pushed. To publish it (this rewrites GitHub's history):
  cd "$WORK"
  git remote add origin $(git -C "$REPO" remote get-url origin)
  git push --force origin $BRANCH
Then on every Sprite that has a clone (fc-court-dev, fc-court, fc-lawyer):
  cd ~/family-court && git fetch origin && git reset --hard origin/$BRANCH
(scripts/deploy.sh uses git pull --ff-only, which refuses rewritten history.)
EOF
else
  echo "Dry run passed. Nothing was changed. Re-run with --apply to write the scrubbed repo."
fi
