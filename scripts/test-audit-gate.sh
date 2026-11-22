#!/usr/bin/env bash
# Checks scripts/audit-gate.sh against fixed reports, so the gate's rules hold without the registry.
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { # name, expected rc, args...
    local name=$1 want=$2; shift 2
    bash scripts/audit-gate.sh "$@" >"$T/out" 2>&1; local got=$?
    if [ "$got" -eq "$want" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $name (rc $got, wanted $want)"; cat "$T/out"; fi
}
cat >"$T/report.json" <<'J'
{"metadata":{"vulnerabilities":{"high":3,"critical":0,"total":3}},
 "vulnerabilities":{
  "braces":{"severity":"high","via":[{"severity":"high","name":"braces","url":"https://github.com/advisories/GHSA-aaaa-bbbb-cccc"}]},
  "micromatch":{"severity":"high","via":["braces"]},
  "fast-glob":{"severity":"high","via":["micromatch"]}}}
J
cat >"$T/allow.json" <<'J'
[{"id":"GHSA-aaaa-bbbb-cccc","package":"braces","reason":"test","expires":"2026-11-04"}]
J
jq '.vulnerabilities.foo={"severity":"critical","via":[{"severity":"critical","name":"foo","url":"https://github.com/advisories/GHSA-xxxx-yyyy-zzzz"}]}' "$T/report.json" >"$T/extra.json"
echo '{"metadata":{"vulnerabilities":{"total":0}},"vulnerabilities":{}}' >"$T/clean.json"
echo '<html>503</html>' >"$T/bad.json"
echo '{' >"$T/badallow.json"
jq '.vulnerabilities.foo={"severity":"high","via":[{"severity":"high","name":"foo","source":1099999}]}' "$T/clean.json" >"$T/nourl.json"
jq '.vulnerabilities.foo={"severity":"high","via":[{"severity":"high","name":"foo","url":7}]}' "$T/clean.json" >"$T/badurl.json"
echo '{"metadata":{"vulnerabilities":{"high":2,"total":2}},"vulnerabilities":{"foo":{"severity":"high","via":["bar"]}}}' >"$T/unread.json"
echo '[{"id":"GHSA-aaaa-bbbb-cccc","expires":"2026-11-04"}]' >"$T/noreason.json"

check "a clean report passes"                       0 "$T/clean.json" "$T/allow.json" 2026-10-04
check "an accepted advisory passes"                 0 "$T/report.json" "$T/allow.json" 2026-10-04
check "an accepted advisory passes on its expiry"   0 "$T/report.json" "$T/allow.json" 2026-11-04
check "it fails the day after the expiry"           1 "$T/report.json" "$T/allow.json" 2026-11-05
check "with no allowlist it fails"                  1 "$T/report.json" "$T/none.json" 2026-10-04
check "another advisory still fails"                1 "$T/extra.json" "$T/allow.json" 2026-10-04
check "an unreadable report fails closed"           1 "$T/bad.json" "$T/allow.json" 2026-10-04
check "an unreadable allowlist fails closed"        1 "$T/report.json" "$T/badallow.json" 2026-10-04
check "an entry with no reason accepts nothing"     1 "$T/report.json" "$T/noreason.json" 2026-10-04
check "an advisory with no url still fails"         1 "$T/nourl.json" "$T/allow.json" 2026-10-04
check "an advisory with a non-string url fails"     1 "$T/badurl.json" "$T/allow.json" 2026-10-04
check "a High count with no advisory read fails"    1 "$T/unread.json" "$T/allow.json" 2026-10-04
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
