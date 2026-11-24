#!/usr/bin/env python3
"""
Real-name audit (RELEASE.md). This file contains no names: every term is read at run time from
people.json (gitignored) and .private-terms (gitignored), or from JSON on stdin (for remote Sprites,
so nothing private is written there). Output never prints a term: matches are masked and labelled
("person[3].name", "extra[1]").

  python3 scripts/audit-private.py repo                 # tracked files + full git history
  python3 scripts/audit-private.py data DIR [LOG ...]   # SQLite DBs and text files under DIR, plus logs
  python3 scripts/audit-private.py terms                # print the terms as JSON (to pipe to a Sprite)
  ... | python3 - data DIR --stdin                      # (remote) read terms from stdin

Exit code 1 if anything was found.
"""
import json, os, re, sqlite3, subprocess, sys

GENERIC_IDS = {"dad", "mom", "gma", "gpa", "grandma", "grandpa", "mother", "father"}


def load_terms(root="."):
    """(label, term) pairs, never empty, plus the allowed phrases."""
    people = json.load(open(os.path.join(root, "people.json")))
    terms, allow = [], []
    for i, p in enumerate(people):
        name = (p.get("name") or "").strip()
        if name.lower() in GENERIC_IDS:
            name = ""  # "Grandma" is a word, not a real name
        if name:
            terms.append((f"person[{i}].name", name))
            for j, tok in enumerate(re.split(r"\s+", name)):
                if len(tok) >= 3 and tok != name:
                    terms.append((f"person[{i}].name.{j}", tok))
        email = (p.get("email") or "").strip()
        if email:
            terms.append((f"person[{i}].email", email))
        pid = (p.get("id") or "").strip()
        alias = (p.get("alias") or "").strip()
        # An id is private unless it's a generic word or just the alias (e.g. "dad").
        if pid and pid.lower() not in GENERIC_IDS and pid.lower() != alias.lower():
            terms.append((f"person[{i}].id", pid))
    path = os.path.join(root, ".private-terms")
    if os.path.exists(path):
        for n, line in enumerate(l.strip() for l in open(path)):
            if not line or line.startswith("#"):
                continue
            if line.lower().startswith("allow:"):
                allow.append(line.split(":", 1)[1].strip())
            else:
                terms.append((f"extra[{n}]", line))
    terms = [(l, t) for l, t in terms if t.strip()]
    # Longest first, de-duplicated (case-insensitive).
    seen, out = set(), []
    for label, t in sorted(terms, key=lambda x: -len(x[1])):
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append((label, t))
    return out, allow


def compile_terms(terms, allow):
    pats = [(label, re.compile(r"(?<![A-Za-z0-9])" + re.escape(t) + r"(?![A-Za-z0-9])", re.I)) for label, t in terms]
    allow_pats = [re.compile(re.escape(a), re.I) for a in allow]
    return pats, allow_pats


def hits_in(text, pats, allow_pats):
    """[(label, masked context)] for every match not inside an allowed phrase."""
    blocked = [(m.start(), m.end()) for a in allow_pats for m in a.finditer(text)]
    out = []
    for label, p in pats:
        for m in p.finditer(text):
            if any(s <= m.start() and m.end() <= e for s, e in blocked):
                continue
            a, b = max(0, m.start() - 30), min(len(text), m.end() + 30)
            ctx = text[a:b]
            for _, q in pats:  # mask every private term in the context, not just this one
                ctx = q.sub("███", ctx)
            out.append((label, ctx.replace("\n", " ")))
    return out


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, errors="replace").stdout


def audit_repo(pats, allow_pats):
    found = 0
    print("== Tracked files (HEAD)")
    for f in git("ls-files").splitlines():
        try:
            data = open(f, "rb").read()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue  # binary: listed separately below
        for n, line in enumerate(data.decode("utf8", "replace").splitlines(), 1):
            for label, ctx in hits_in(line, pats, allow_pats):
                found += 1
                print(f"  {f}:{n}  {label}  …{ctx}…")
    binaries = [f for f in git("ls-files").splitlines() if os.path.exists(f) and b"\0" in open(f, "rb").read(8000)]
    print(f"  (binary files, not text-searchable: {', '.join(binaries) or 'none'})")

    print("== Git history: authors, committers, messages")
    for line in git("log", "--all", "--format=%h%x00%an <%ae>%x00%cn <%ce>%x00%B%x01").split("\x01"):
        if not line.strip():
            continue
        h, author, committer, msg = (line.strip("\n").split("\x00") + ["", "", ""])[:4]
        for what, text in (("author", author), ("committer", committer), ("message", msg)):
            for label, ctx in hits_in(text, pats, allow_pats):
                found += 1
                print(f"  {h} {what}  {label}  …{ctx}…")

    print("== Git history: every version of every file (added and removed lines)")
    commit, path = "", ""
    for line in git("log", "--all", "-p", "--format=COMMIT %h", "--no-color").splitlines():
        if line.startswith("COMMIT "):
            commit = line.split()[1]
        elif line.startswith("diff --git "):
            path = line.split(" b/", 1)[-1]
        elif line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
            for label, ctx in hits_in(line[1:], pats, allow_pats):
                found += 1
                print(f"  {commit} {path}  {label}  …{ctx}…")
    for f in git("log", "--all", "--name-only", "--format=").splitlines():
        for label, ctx in hits_in(f, pats, allow_pats):
            found += 1
            print(f"  file name in history: {f}  {label}")
    return found


def audit_data(directory, logs, pats, allow_pats):
    found = 0
    print(f"== Data under {directory}")
    for root, _, files in os.walk(directory):
        for name in sorted(files):
            p = os.path.join(root, name)
            if name.endswith((".db-wal", ".db-shm")):
                continue
            if name.endswith(".db"):
                try:
                    db = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
                    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                        cols = [c[1] for c in db.execute(f"PRAGMA table_info({table})")]
                        for row in db.execute(f"SELECT rowid, * FROM {table}"):
                            for col, val in zip(["rowid", *cols], row):
                                if isinstance(val, str):
                                    for label, ctx in hits_in(val, pats, allow_pats):
                                        found += 1
                                        print(f"  {p} {table}.{col} (rowid {row[0]})  {label}  …{ctx}…")
                except sqlite3.Error as e:
                    print(f"  {p}: couldn't read ({e})")
                continue
            data = open(p, "rb").read()
            if b"\0" in data[:8000]:
                continue  # audio etc.
            for n, line in enumerate(data.decode("utf8", "replace").splitlines(), 1):
                for label, ctx in hits_in(line, pats, allow_pats):
                    found += 1
                    print(f"  {p}:{n}  {label}  …{ctx}…")
    for log in logs:
        if not os.path.exists(log):
            continue
        print(f"== Log {log}")
        for n, line in enumerate(open(log, errors="replace"), 1):
            for label, ctx in hits_in(line, pats, allow_pats):
                found += 1
                print(f"  {log}:{n}  {label}  …{ctx[:120]}…")
    return found


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    if "--stdin" in args:
        args.remove("--stdin")
        payload = json.load(sys.stdin)
        terms, allow = [tuple(t) for t in payload["terms"]], payload["allow"]
    else:
        terms, allow = load_terms()
    if args[0] == "terms":
        print(json.dumps({"terms": terms, "allow": allow}))
        return
    pats, allow_pats = compile_terms(terms, allow)
    print(f"({len(terms)} private terms; {len(allow)} allowed phrase(s))")
    found = audit_repo(pats, allow_pats) if args[0] == "repo" else audit_data(args[1], args[2:], pats, allow_pats)
    print(f"== {found} finding(s)")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
