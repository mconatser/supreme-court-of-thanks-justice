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
#   BOX_FOLDER_ID    folder to list (defaults to BOX_RECORDS_FOLDER_ID); BOX_FAMILY_CODE_FILE_ID is checked too
#   TYPESAFE_BASE, OLLAMA_BASE, BOX_BASE, AGENTMAIL_BASE
#                    full gateway_base_url overrides, if auto-discovery picks the wrong one
#   ELEVENLABS_BASE  the Custom API connector for https://api.elevenlabs.io (TTS goes through it;
#                    the official ElevenLabs connector doesn't forward text-to-speech)
#   ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID   voice + model for the TTS check
#   SMOKE_LIST_FILE  use a saved /gateway/list response instead of fetching (for testing)
#
# If a .env file sits next to scripts/, it's loaded first (values already exported win).

set -uo pipefail

ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -z "${!key:-}" ] && [ -n "$value" ] && export "$key=$value"
  done < "$ENV_FILE"
fi

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
  FOLDER="${BOX_FOLDER_ID:-${BOX_RECORDS_FOLDER_ID:-}}"
  if [ -n "$FOLDER" ]; then
    check "Box: folder listing" GET "$BX/2.0/folders/${FOLDER}/items?limit=20&fields=name,type"
  else
    skip "Box folder listing: set BOX_FOLDER_ID or BOX_RECORDS_FOLDER_ID"
  fi
  if [ -n "${BOX_FAMILY_CODE_FILE_ID:-}" ]; then
    check "Box: Family Code file info" GET "$BX/2.0/files/${BOX_FAMILY_CODE_FILE_ID}?fields=name,file_version,modified_at"
  fi
fi

# ---------- 5. AgentMail ----------

echo "== 5. AgentMail =="
AM="$(base_for "${AGENTMAIL_BASE:-}" agentmail)"
if [ -z "$AM" ]; then
  skip "AgentMail: no connector found (fine for tonight; needed by Wednesday)"
else
  # The key is scoped to the clerk's inbox, so GET /v0/inboxes is 403 by design. /v0/auth/me works for scoped keys.
  check "AgentMail: who am I (key scope)" GET "$AM/v0/auth/me"
fi

# ---------- 6. ElevenLabs (text to speech via the Custom API connector) ----------

echo "== 6. ElevenLabs text to speech =="
EL="${ELEVENLABS_BASE:-}"
EL="${EL%/}"
if [ -z "$EL" ]; then
  skip "ElevenLabs TTS: set ELEVENLABS_BASE to the Custom API connector's gateway_base_url"
elif [ -z "${ELEVENLABS_VOICE_ID:-}" ]; then
  skip "ElevenLabs TTS: set ELEVENLABS_VOICE_ID"
else
  TTS_BODY="$(python3 -c 'import json, os; print(json.dumps({"text": "Order in the court!", "model_id": os.environ.get("ELEVENLABS_MODEL_ID") or "eleven_flash_v2_5"}))')"
  out="$TMP_DIR/tts.mp3"
  read -r code ctype < <(curl -sS -o "$out" -w '%{http_code} %{content_type}\n' -X POST \
    -H 'Content-Type: application/json' -H 'Accept: audio/mpeg' --data-binary "$TTS_BODY" \
    "$EL/v1/text-to-speech/${ELEVENLABS_VOICE_ID}") || code="000"
  bytes="$(wc -c < "$out" 2>/dev/null || echo 0)"
  if [[ "$code" == 2* && "$ctype" == audio/* && "$bytes" -gt 1000 ]]; then
    echo "PASS  ElevenLabs TTS: \"Order in the court!\"  (HTTP $code, $ctype, $bytes bytes, about 19 characters of quota)"; PASS=$((PASS + 1))
  else
    echo "FAIL  ElevenLabs TTS  (HTTP $code, ${ctype:-no content type}, $bytes bytes)"; FAIL=$((FAIL + 1))
    [[ "$ctype" == *json* || "$ctype" == text/* ]] && head -c 600 "$out" && echo
    echo "      Check that ELEVENLABS_BASE is the Custom API connector (not the official one) and that it sends xi-api-key."
  fi
  echo
fi

# ---------- summary ----------

echo "== Summary: $PASS passed, $FAIL failed, $SKIP skipped =="
echo "Tonight's minimum: the TypeSafe and Ollama checks pass."
[ "$FAIL" -eq 0 ]
