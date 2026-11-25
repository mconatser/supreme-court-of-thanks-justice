#!/usr/bin/env bash
# Start the docket fresh for the demo (RELEASE.md §2), and make every people.json id its alias, so no
# id is ever a real first name. Run INSIDE the Sprite (fc-court, or fc-court-dev):
#
#   bash scripts/demo-reset.sh            # dry run: show what would change
#   bash scripts/demo-reset.sh --apply    # stop the service, back up, rename ids, clear, restart
#
# Nothing is deleted: court.db, lawyer.db, the recorded verdicts and the old people.json move to
# data/backup-<time>/. Once you've checked the reset worked, delete that folder (it still holds the
# old data, real first names in ids included); the script prints the command at the end.
# Box records are not touched (they stay in the private Box account).
#
# The ids are renamed together with the reset on purpose: the databases store ids, so renaming them
# without clearing the databases would cut old cases off from their people.
set -euo pipefail
cd "$(dirname "$0")/.."
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
SERVICE="${SERVICE:-court}"

shopt -s nullglob
items=(data/court.db data/court.db-wal data/court.db-shm data/lawyer.db data/lawyer.db-wal data/lawyer.db-shm data/audio)
present=()
for p in "${items[@]}"; do [ -e "$p" ] && present+=("$p"); done

# The id plan: each id becomes a slug of its alias. Old ids are never printed (some are real names).
plan="$(python3 - <<'PY'
import json, os, re, sys
if not os.path.exists("people.json"):
    print("NONE")
    sys.exit()
people = json.load(open("people.json"))
slug = lambda a: re.sub(r"[^a-z0-9]+", "-", a.lower()).strip("-")
new = [slug(p["alias"]) for p in people]
if any(not n for n in new) or len(set(new)) != len(new):
    print("CLASH")
    sys.exit()
changes = [f"  entry {i + 1} ({p['alias']}): id → {n}" for i, (p, n) in enumerate(zip(people, new)) if p["id"] != n]
print("\n".join(changes) if changes else "SAME")
PY
)"
[ "$plan" = "CLASH" ] && { echo "Two aliases would make the same id (or an alias is empty). Fix people.json first."; exit 1; }

cases="$( [ -e data/court.db ] && node -e "try{const D=require('better-sqlite3');console.log(new D('data/court.db',{readonly:true}).prepare('select count(*) n from cases').get().n)}catch{console.log('?')}" || echo 0)"
backup="data/backup-$(date +%Y%m%d-%H%M%S)"

echo "Will move to $backup/ ($cases court case(s)):"
if [ ${#present[@]} -gt 0 ]; then printf '  %s\n' "${present[@]}"; else echo "  (no databases or audio yet)"; fi
case "$plan" in
  NONE) echo "No people.json here (fc-lawyer): no ids to rename." ;;
  SAME) echo "people.json: every id already matches its alias." ;;
  *) echo "people.json ids (a copy of the old file goes into the backup):"; echo "$plan" ;;
esac
if [ "$APPLY" != 1 ]; then
  echo "Dry run. Nothing changed. Re-run with --apply."
  exit 0
fi

sprite-env services stop "$SERVICE" >/dev/null 2>&1 || true
mkdir -p "$backup"
chmod 700 "$backup"
# Listed again now that the service is stopped: closing SQLite folds the -wal/-shm files in and deletes them.
for p in "${items[@]}"; do
  if [ -e "$p" ]; then mv "$p" "$backup/"; fi
done
if [ "$plan" != "NONE" ] && [ "$plan" != "SAME" ]; then
  cp -p people.json "$backup/people.json"
  python3 - <<'PY'
import json, re
people = json.load(open("people.json"))
for p in people:
    p["id"] = re.sub(r"[^a-z0-9]+", "-", p["alias"].lower()).strip("-")
tmp = "people.json.tmp"
json.dump(people, open(tmp, "w"), indent=2, ensure_ascii=False)
open(tmp, "a").write("\n")
import os
os.replace(tmp, "people.json")
PY
  echo "people.json: ids renamed to their aliases."
fi
npm run -s migrate
sprite-env services start "$SERVICE" >/dev/null 2>&1 || sprite-env services restart "$SERVICE" >/dev/null 2>&1 || true

cat <<EOF

Done. The docket is empty and cases start at #0001 again.

Check it worked: open the docket, file a quick case, and make sure the parties show their aliases.
Then delete the backup (it still holds the old databases, recordings and the old people.json):

  rm -rf "$PWD/$backup"

(Or every backup at once: rm -rf "$PWD"/data/backup-*)
Box still holds the old Case-NNNN.md records; move them aside if new records shouldn't become versions of them.
EOF
