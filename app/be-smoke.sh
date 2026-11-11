#!/usr/bin/env bash
# Smoke test for BE ticket intake against throwaway repos. No agent runs: Rocco and Gigi are on a break.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
PORT=4399
URL="http://localhost:$PORT"
pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

git init -q --bare -b main "$tmp/origin.git"
for r in reck gif; do
  git clone -q "$tmp/origin.git" "$tmp/$r" 2>/dev/null
  git -C "$tmp/$r" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$tmp/$r" push -q origin HEAD:main
done
git -C "$tmp/reck" push -q origin HEAD:refs/heads/RECK-116
before=$(git -C "$tmp/reck" status --porcelain)

AI_TEAM_DATA="$tmp/data" PORT=$PORT DAILY_AT= RECK_API_DIR="$tmp/reck" GIF_API_DIR="$tmp/gif" node app/server.js >"$tmp/server.log" 2>&1 &
pid=$!
for _ in $(seq 50); do curl -sf "$URL/api/state" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$URL/api/state" >/dev/null || fail "server did not start: $(cat "$tmp/server.log" "$tmp/data/logs/server.log" 2>/dev/null)"

post() { curl -s -o "$tmp/body" -w '%{http_code}' -H 'Content-Type: application/json' -d "$2" "$URL$1"; }
for role in rc-dev gl-dev; do
  body="{\"role\":\"$role\",\"on\":true}"
  code=$(post /api/break "$body")
  [ "$code" = 200 ] || fail "break $role: $code $(cat "$tmp/body")"
done

[ "$(post /api/projects '{"kind":"be-ticket","ticketKey":"MINT-1","idea":"x"}')" = 400 ] || fail "MINT-1 not rejected"
grep -q 'RECK-' "$tmp/body" || fail "MINT-1 error does not name RECK-: $(cat "$tmp/body")"

[ "$(post /api/projects '{"kind":"be-ticket","ticketKey":"RECK-5","idea":"Fix X"}')" = 201 ] || fail "RECK-5 not created: $(cat "$tmp/body")"
curl -sf "$URL/api/state" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const p = s.projects.find((x) => x.kind === "be-ticket" && x.ticketKey === "RECK-5");
  if (!p || p.repo !== "reviewcook-api" || p.tasks[0]?.owner !== "rc-dev" || p.tasks[0]?.status !== "TODO" || !p.tasks[0]?.queuedAt) { console.error(JSON.stringify(p)); process.exit(1); }
' || fail "state does not show RECK-5 as a queued (TODO) rc-dev ticket"

[ "$(post /api/projects '{"kind":"be-ticket","ticketKey":"RECK-5","idea":"Fix X"}')" = 400 ] || fail "duplicate RECK-5 not rejected"
grep -q 'already added' "$tmp/body" || fail "duplicate error: $(cat "$tmp/body")"

squad() { code=$(post /api/squad/agent "$1"); [ "$code" = "$2" ] || fail "squad $1 → $code $(cat "$tmp/body")"; [ -z "${3:-}" ] || grep -q "$3" "$tmp/body" || fail "squad $1: $(cat "$tmp/body")"; }
squad '{"role":"rc-dev","action":"stop"}' 400 'not working'
squad '{"role":"x","action":"stop"}' 400
squad '{"role":"gl-dev","action":"swap","ticketId":"RECK-5"}' 400 'another dev'
squad '{"role":"be-qa","action":"swap","ticketId":"RECK-5"}' 400
squad '{"role":"rc-dev","action":"swap","ticketId":"RECK-5"}' 200
curl -sf "$URL/api/state" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!(s.projects.find((x) => x.ticketKey === "RECK-5")?.tasks[0]?.priority > 0)) process.exit(1);
' || fail "swap did not raise RECK-5 priority"

grep -qx '.aiteam/' "$tmp/reck/.git/info/exclude" || fail ".aiteam/ not in info/exclude"
grep -q '"reviewcook-api/RECK-5"' "$tmp/data/be-tickets.json" || fail "memory entry missing"
[ "$(git -C "$tmp/reck" status --porcelain)" = "$before" ] || fail "reck working tree changed"
[ "$(git -C "$tmp/reck" rev-parse --abbrev-ref HEAD)" = main ] || fail "reck branch changed"

echo "BE smoke OK"
