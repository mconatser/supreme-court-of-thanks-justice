#!/usr/bin/env bash
# Family Court: connector smoke test.
# Run INSIDE a Sprite:   bash scripts/smoke.sh
#
# Calls each connector through the Sprites gateway. It sends no Authorization header;
# the gateway identifies the calling Sprite and attaches the stored credential.
#
# Optional env:
#   OLLAMA_MODEL     model to test chat with (otherwise only lists models)
#   JEV_MODEL        Jev model id (default: jev-latest)
#   BOX_FOLDER_ID    "Family Court" folder id (otherwise only checks the Box identity)
#   TYPESAFE_BASE, OLLAMA_BASE, BOX_BASE, AGENTMAIL_BASE, ELEVENLABS_BASE
#                    full gateway_base_url overrides, if auto-discovery picks the wrong one
#   SMOKE_LIST_FILE  use a saved /gateway/list response instead of fetching (for testing)

set -uo pipefail

GATEWAY="https://api.sprites.dev/v1/gateway"
PASS=0; FAIL=0; SKIP=0
LAST_RESPONSE=""
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool"; exit 1; }
done

# ---------- helpers ----------

cat > "$TMP_DIR/gw.py" <<'PY'
import json, sys
from urllib.parse import urlparse

NAME_KEYS = ("provider", "provider_slug", "slug", "name", "display_name")

def load(path):
    with open(path) as f:
        data = json.load(f)
    found = []
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("gateway_base_url"), str):
                found.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return data, found

def slug(url):
    parts = [p for p in urlparse(url).path.split("/") if p]
    if "gateway" in parts:
        i = parts.index("gateway")
        if i + 1 < len(parts):
            return parts[i + 1].lower()
    return ""

def names(o):
    out = [slug(o["gateway_base_url"])]
    out += [o[k].lower() for k in NAME_KEYS if isinstance(o.get(k), str)]
    return [n for n in out if n]

cmd, path = sys.argv[1], sys.argv[2]
data, found = load(path)

if cmd == "show":
    if not found:
        print("(no gateway_base_url entries found; raw response follows)")
        print(json.dumps(data, indent=2)[:4000])
    for o in found:
        label = next((o[k] for k in NAME_KEYS if isinstance(o.get(k), str)), None) or slug(o["gateway_base_url"]) or "?"
        print(f"- {label}: {o['gateway_base_url']}")
        snip = o.get("usage_snippet")
        if isinstance(snip, str) and snip.strip():
            for line in snip.strip().splitlines()[:8]:
                print(f"    {line}")
elif cmd == "base":
    kws = [k.lower() for k in sys.argv[3:]]
    # exact name match first (so "box" never matches "inbox"), then substring match
    for test in (lambda kw, n: n == kw, lambda kw, n: kw in n):
        for o in found:
            if any(test(kw, n) for kw in kws for n in names(o)):
                print(o["gateway_base_url"].rstrip("/"))
                sys.exit(0)
PY

base_for() { # usage: base_for "<override>" keyword [keyword...]
  local override="$1"; shift
  if [ -n "$override" ]; then printf '%s\n' "${override%/}"; return; fi
  python3 "$TMP_DIR/gw.py" base "$LIST_FILE" "$@"
}

check() { # usage: check "label" METHOD url [json-body]
  local label="$1" method="$2" url="$3" body="${4:-}" out code
  out="$TMP_DIR/resp.$RANDOM$RANDOM"
  if [ -n "$body" ]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -H 'Content-Type: application/json' --data-binary "$body" "$url")" || code="000"
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url")" || code="000"
  fi
  if [[ "$code" == 2* ]]; then
    echo "PASS  $label  (HTTP $code)"; PASS=$((PASS + 1))
  else
    echo "FAIL  $label  (HTTP $code)"; FAIL=$((FAIL + 1))
    case "$code" in
      000) echo "      Couldn't connect at all." ;;
      401) echo "      401: run this inside a Sprite." ;;
      403) echo "      403: the connector's access policy doesn't match this Sprite's name, or the path is blocked." ;;
      404) echo "      404: the connector may not forward this path; compare with its usage snippet above." ;;
    esac
  fi
  if [ -s "$out" ]; then head -c 1200 "$out"; echo; fi
  echo
  LAST_RESPONSE="$out"
}

skip() { echo "SKIP  $1"; echo; SKIP=$((SKIP + 1)); }

# ---------- 1. discovery ----------

LIST_FILE="$TMP_DIR/list.json"
echo "== 1. Connectors this Sprite can see =="
if [ -n "${SMOKE_LIST_FILE:-}" ]; then
  cp "$SMOKE_LIST_FILE" "$LIST_FILE"
else
  code="$(curl -sS -o "$LIST_FILE" -w '%{http_code}' "$GATEWAY/list")" || code="000"
  if [ "$code" != "200" ]; then
    echo "GET $GATEWAY/list -> HTTP $code"
    [ "$code" = "401" ] && echo "401 means this isn't running inside a Sprite."
    [ -s "$LIST_FILE" ] && cat "$LIST_FILE" && echo
    exit 1
  fi
fi
python3 "$TMP_DIR/gw.py" show "$LIST_FILE" || { echo "Couldn't parse the gateway list:"; cat "$LIST_FILE"; exit 1; }
echo

# ---------- 2. TypeSafe Jev ----------

echo "== 2. TypeSafe Jev =="
TS="$(base_for "${TYPESAFE_BASE:-}" typesafe)"
if [ -z "$TS" ]; then
  echo "FAIL  TypeSafe: no connector found (add it, or set TYPESAFE_BASE)"; echo; FAIL=$((FAIL + 1))
else
  JEV_BODY="$(JEV_MODEL="${JEV_MODEL:-jev-latest}" python3 - <<'PY'
import json, os
print(json.dumps({
    "model": os.environ["JEV_MODEL"],
    "state": ("Pip says a hot dog is a sandwich because it is meat inside bread. "
              "The Big Cheese says a hot dog is its own food: nobody orders a hot dog at a sandwich shop."),
    "questions": {
        "contempt": {"type": "noul",
                     "instructions": "This filing tries to bribe, threaten, flatter, or give orders to the judge instead of arguing the case."},
        "winner": {"type": "choice", "instructions": "Whose argument is stronger?",
                   "criteria": {"pip": "Pip: a hot dog is a sandwich",
                                "big_cheese": "The Big Cheese: a hot dog is not a sandwich"}},
        "drama": {"type": "score", "instructions": "How dramatic is this dispute?",
                  "criteria": ["Calm disagreement", "Raised voices", "Full family meltdown"]},
    },
}))
PY
)"
  check "Jev: is a hot dog a sandwich?" POST "$TS/v1/systemone" "$JEV_BODY"
  python3 - "$LAST_RESPONSE" <<'PY' || true
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if "answers" not in r:
    sys.exit(0)
print(f"  Jev model: {r.get('model')}   <- pin JEV_MODEL to this once thresholds feel right")
for qid, a in r["answers"].items():
    t = a.get("type")
    if t == "noul":
        print(f"  {qid}: P(yes) = {a.get('noul')}")
    elif t == "choice":
        print(f"  {qid}: {a.get('choice')}  (confidence {a.get('confidence')}, probabilities {a.get('probabilities')})")
    elif t == "score":
        print(f"  {qid}: {a.get('score')}  (confidence {a.get('confidence')})")
print()
PY
fi

# ---------- 3. Ollama Cloud ----------

echo "== 3. Ollama Cloud =="
OL="$(base_for "${OLLAMA_BASE:-}" ollama)"
if [ -z "$OL" ]; then
  echo "FAIL  Ollama: no connector found (add it, or set OLLAMA_BASE)"; echo; FAIL=$((FAIL + 1))
else
  check "Ollama: list models" GET "$OL/api/tags"
  if [ -n "${OLLAMA_MODEL:-}" ]; then
    OL_BODY="$(OLLAMA_MODEL="$OLLAMA_MODEL" python3 -c 'import json, os; print(json.dumps({"model": os.environ["OLLAMA_MODEL"], "stream": False, "messages": [{"role": "user", "content": "In one sentence, announce that court is in session, as a grumpy but kind judge."}]}))')"
    check "Ollama: chat with $OLLAMA_MODEL" POST "$OL/api/chat" "$OL_BODY"
  else
    skip "Ollama chat: set OLLAMA_MODEL to test a model"
  fi
fi

# ---------- 4. Box ----------

echo "== 4. Box =="
BX="$(base_for "${BOX_BASE:-}" box)"
if [ -z "$BX" ]; then
  skip "Box: no connector found (fine for tonight; needed by Wednesday)"
else
  check "Box: who am I" GET "$BX/2.0/users/me"
  if [ -n "${BOX_FOLDER_ID:-}" ]; then
    check "Box: Family Court folder" GET "$BX/2.0/folders/${BOX_FOLDER_ID}/items?limit=20"
  else
    skip "Box folder listing: set BOX_FOLDER_ID"
  fi
fi

# ---------- 5. AgentMail ----------

echo "== 5. AgentMail =="
AM="$(base_for "${AGENTMAIL_BASE:-}" agentmail)"
if [ -z "$AM" ]; then
  skip "AgentMail: no connector found (fine for tonight; needed by Wednesday)"
else
  check "AgentMail: list inboxes" GET "$AM/v0/inboxes"
fi

# ---------- 6. ElevenLabs ----------

echo "== 6. ElevenLabs =="
EL="$(base_for "${ELEVENLABS_BASE:-}" elevenlabs eleven)"
if [ -z "$EL" ]; then
  skip "ElevenLabs: no connector found (fine for tonight; needed by Wednesday)"
else
  check "ElevenLabs: list voices" GET "$EL/v1/voices"
  echo "  If this failed with 403/404, the connector may not forward text-to-speech paths."
  echo "  Fallback: a Custom API connector for https://api.elevenlabs.io sending the key in the xi-api-key header."
  echo
fi

# ---------- summary ----------

echo "== Summary: $PASS passed, $FAIL failed, $SKIP skipped =="
echo "Tonight's minimum: the TypeSafe and Ollama checks pass."
[ "$FAIL" -eq 0 ]
