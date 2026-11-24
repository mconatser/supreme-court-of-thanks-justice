#!/usr/bin/env bash
# Release prep: scrub real names and family email addresses from the WHOLE git history (contents,
# file names, commit messages, authors and committers), keeping every commit and its dates. The
# history is our evidence that the project was built during Hacksgiving week, so nothing is squashed.
#
# This file contains no names. What gets replaced comes, at run time, from gitignored files:
#   people.json           every person's real name (→ their court alias), email, and id
#   .private-terms        extra private words (one per line; "word ==> replacement" to choose one)
#   .release-scrub.local  author: Name <email>      the identity every commit is attributed to
#                         rename: OLD.md:NEW.md     files to rename across history (optional, repeatable)
#
#   scripts/release-scrub.sh             # dry run (default): scrub a throwaway clone, run the audit on it
#   scripts/release-scrub.sh --apply     # write the scrubbed repo to --out (never pushes)
#   options: --out DIR (default ../family-court-release)
#
# Needs git-filter-repo (uv tool install git-filter-repo==2.47.0).
set -euo pipefail

OUT=""
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
die() { echo "release-scrub: $*" >&2; exit 1; }
for f in people.json .private-terms .release-scrub.local; do [ -f "$f" ] || die "missing $f (gitignored; see the top of this script)."; done
for f in people.json .private-terms .release-scrub.local; do git check-ignore -q "$f" || die "$f must be gitignored."; done
command -v git-filter-repo >/dev/null || die "git-filter-repo isn't installed (uv tool install git-filter-repo==2.47.0)."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  [ "$APPLY" = 1 ] && die "commit or stash your changes first (the scrub works on what's committed)."
  echo "Note: you have uncommitted changes; the dry run scrubs what's committed."
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$APPLY" = 1 ]; then
  OUT="${OUT:-$(dirname "$REPO")/family-court-release}"
  [ ! -e "$OUT" ] || die "$OUT already exists; remove it or pass --out."
  WORK="$OUT"
else
  WORK="$(mktemp -d)/family-court-scrub"
fi
RULES="$(mktemp -d)"
chmod 700 "$RULES"
trap 'rm -rf "$RULES"; [ "$APPLY" = 1 ] || rm -rf "$(dirname "$WORK")"' EXIT

# Build the rules from the private files. Prints counts only, never the words themselves.
python3 - "$RULES" <<'PY'
import json, re, sys
out = sys.argv[1]
people = json.load(open("people.json"))
GENERIC = {"dad", "mom", "gma", "gpa", "grandma", "grandpa", "mother", "father"}
local = [l.strip() for l in open(".release-scrub.local") if l.strip() and not l.startswith("#")]
author = next((l.split(":", 1)[1].strip() for l in local if l.lower().startswith("author:")), "")
renames = [l.split(":", 1)[1].strip() for l in local if l.lower().startswith("rename:")]
if not re.fullmatch(r"[^<>]+ <[^<>@]+@[^<>]+>", author):
    sys.exit("release-scrub: .release-scrub.local needs a line like: author: Your Name <you@users.noreply.github.com>")
family_emails = {(p.get("email") or "").strip().lower() for p in people} - {""}
if author.split("<")[1].rstrip(">").lower() in family_emails:
    sys.exit("release-scrub: the author email is a family address from people.json. Use your GitHub noreply address instead.")
allow = [l.split(":", 1)[1].strip() for l in open(".private-terms") if l.lower().startswith("allow:")]
allowed = {a.lower() for a in allow} | {t.lower() for a in allow for t in a.split()}

rules = []  # (regex, replacement), applied in order
for r in renames:  # links to renamed files first
    old, new = r.split(":", 1)
    rules.append((r"\b" + re.escape(old) + r"\b", new))
for p in people:
    alias = p["alias"].strip()
    name = (p.get("name") or "").strip()
    if name and name.lower() not in GENERIC and name.lower() not in allowed:
        for token in sorted({name, *name.split()}, key=len, reverse=True):
            if len(token) >= 3 and token.lower() not in allowed:
                rules.append((r"(?i)(?<![A-Za-z0-9])" + re.escape(token) + r"(?![A-Za-z0-9])", alias))
    pid = (p.get("id") or "").strip()
    if pid and pid.lower() not in GENERIC and pid.lower() != alias.lower():
        rules.append((r"(?i)(?<![A-Za-z0-9])" + re.escape(pid) + r"(?![A-Za-z0-9])", alias))
    email = (p.get("email") or "").strip()
    if email:
        rules.append((r"(?i)" + re.escape(email), "[email removed]"))
for line in open(".private-terms"):
    line = line.strip()
    if not line or line.startswith("#") or line.lower().startswith("allow:"):
        continue
    word, _, repl = (part.strip() for part in line.partition("==>"))
    rules.append((r"(?i)(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])", repl or "[redacted]"))

with open(f"{out}/replacements.txt", "w") as f:
    for rx, repl in rules:
        f.write(f"regex:{rx}==>{repl}\n")
# Every identity in history becomes the release author (filter-repo mailmap: "New <new> <old>").
import subprocess
idents = set(subprocess.run(["git", "log", "--all", "--format=%an <%ae>%n%cn <%ce>"], capture_output=True, text=True).stdout.splitlines())
with open(f"{out}/mailmap", "w") as f:
    for ident in sorted(i for i in idents if i.strip()):
        f.write(f"{author} {ident}\n")
with open(f"{out}/renames", "w") as f:
    f.write("".join(r + "\n" for r in renames))
print(f"Rules: {len(rules)} replacement(s), {len(renames)} rename(s), {len(idents)} identit(y/ies) mapped to the release author.")
PY

echo "== Release scrub ($([ "$APPLY" = 1 ] && echo APPLY || echo DRY RUN))"
# master only, no tags: the public repo gets exactly the scrubbed branch and nothing else.
git clone --quiet --no-local --single-branch --no-tags --branch "$BRANCH" "$REPO" "$WORK"
BEFORE_DATES="$(git -C "$WORK" log --reverse --format='%aI %cI')"
BEFORE_COUNT="$(git -C "$WORK" rev-list --count HEAD)"

ARGS=(--force --replace-text "$RULES/replacements.txt" --replace-message "$RULES/replacements.txt" --mailmap "$RULES/mailmap")
while IFS= read -r r || [ -n "$r" ]; do [ -n "$r" ] && ARGS+=(--path-rename "$r"); done < "$RULES/renames"
(cd "$WORK" && git filter-repo "${ARGS[@]}" >/dev/null)

AFTER_DATES="$(git -C "$WORK" log --reverse --format='%aI %cI')"
AFTER_COUNT="$(git -C "$WORK" rev-list --count HEAD)"
OK=1
echo "Commits: $BEFORE_COUNT before, $AFTER_COUNT after"
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] || { echo "  !! commit count changed"; OK=0; }
if [ "$BEFORE_DATES" = "$AFTER_DATES" ]; then
  echo "Dates:   identical (author and committer, every commit), $(echo "$AFTER_DATES" | head -1 | cut -d' ' -f1) to $(echo "$AFTER_DATES" | tail -1 | cut -d' ' -f1)"
else
  echo "  !! commit dates changed"; OK=0
fi
REFS="$(git -C "$WORK" for-each-ref --format='%(refname)' | grep -v "^refs/heads/$BRANCH\$" | grep -v '^refs/remotes/' || true)"
if [ -n "$REFS" ]; then echo "  !! other refs in the scrubbed repo:"; echo "$REFS" | sed 's/^/     /'; OK=0; else echo "Refs:    $BRANCH only, no tags"; fi
echo "Authors and committers after:"
git -C "$WORK" log --all --format='  %an <%ae> / %cn <%ce>' | sort | uniq -c

# The proof: the same audit, on the scrubbed history. Terms are piped in, never written there.
echo "Audit of the scrubbed repo (every file version, message and identity):"
if python3 scripts/audit-private.py terms | (cd "$WORK" && python3 "$REPO/scripts/audit-private.py" repo --stdin) > "$RULES/audit.txt"; then
  echo "  clean: no real names, family emails or private terms anywhere"
else
  grep -E '^== [0-9]+ finding' "$RULES/audit.txt" | sed 's/^/  !! /'
  grep -E '^  ' "$RULES/audit.txt" | head -20
  OK=0
fi

echo
if [ "$OK" != 1 ]; then echo "Problems found. Nothing was pushed."; exit 1; fi
if [ "$APPLY" = 1 ]; then
  cat <<EOF
The scrubbed repo is ready at: $WORK
Nothing has been pushed. It goes to a NEW public repo; this private repo stays as it is.
  1. On GitHub, create a new empty public repo (no README, license or .gitignore).
  2. Push the scrubbed $BRANCH, and only $BRANCH (no tags):
       cd "$WORK"
       git remote add public https://github.com/<you>/<new-repo>.git
       git push public $BRANCH
  3. Check it on GitHub before you share the link: search the repo for the names, and look at a
     few old commits. Their dates should fall between Nov 23 and Nov 25.
The Sprites keep deploying from the private repo; nothing changes there.
EOF
else
  echo "Dry run passed. Nothing was changed. Re-run with --apply to write the scrubbed repo."
fi
