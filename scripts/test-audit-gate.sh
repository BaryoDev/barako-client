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
echo '{"metadata":{"vulnerabilities":{"high":0,"critical":0,"total":0}},"vulnerabilities":{}}' >"$T/clean.json"
echo '<html>503</html>' >"$T/bad.json"
echo '{' >"$T/badallow.json"
jq '.vulnerabilities.foo={"severity":"high","via":[{"severity":"high","name":"foo","source":1099999}]}' "$T/clean.json" >"$T/nourl.json"
jq '.vulnerabilities.foo={"severity":"high","via":[{"severity":"high","name":"foo","url":7}]}' "$T/clean.json" >"$T/badurl.json"
echo '{"metadata":{"vulnerabilities":{"high":2,"critical":0,"total":2}},"vulnerabilities":{"foo":{"severity":"high","via":["bar"]}}}' >"$T/unread.json"
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
# Allowlist dates are checked as dates, not compared as strings.
for bad in never 9 2099-13-45 2099-02-30 "2099-1-1"; do
    printf '[{"id":"GHSA-aaaa-bbbb-cccc","package":"braces","reason":"test","expires":"%s"}]\n' "$bad" >"$T/baddate.json"
    check "an expiry of $bad accepts nothing"       1 "$T/report.json" "$T/baddate.json" 2026-10-04
done
echo '[{"id":"GHSA-aaaa-bbbb-cccc","package":"braces","reason":"test","expires":20991231}]' >"$T/numdate.json"
check "a numeric expiry accepts nothing"            1 "$T/report.json" "$T/numdate.json" 2026-10-04
echo '[{"id":"GHSA-aaaa-bbbb-cccc","package":"braces","reason":"","expires":"2099-12-31"}]' >"$T/emptyreason.json"
check "an empty reason accepts nothing"             1 "$T/report.json" "$T/emptyreason.json" 2026-10-04
echo '{"id":"GHSA-aaaa-bbbb-cccc","reason":"x","expires":"2099-12-31"}' >"$T/notarray.json"
check "an allowlist that is not an array fails"     1 "$T/report.json" "$T/notarray.json" 2026-10-04
named=$(bash scripts/audit-gate.sh "$T/report.json" "$T/baddate.json" 2026-10-04 2>&1)
if grep -q 'entry 0 .*GHSA-aaaa-bbbb-cccc.*2099-1-1' <<<"$named"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: a bad entry is named"; fi

# A count that is not a number fails, even when the advisory itself is accepted.
jq '.metadata.vulnerabilities.high="3"' "$T/report.json" >"$T/strcount.json"
check "a string High count fails closed"            1 "$T/strcount.json" "$T/allow.json" 2026-10-04

# High and Critical counts must both be present nonnegative integers; anything else is unreadable.
jq '.metadata.vulnerabilities.high=false' "$T/clean.json" >"$T/c-false.json"
jq '.metadata.vulnerabilities.critical=-1' "$T/clean.json" >"$T/c-neg.json"
jq '.metadata.vulnerabilities.high=1.5' "$T/clean.json" >"$T/c-frac.json"
jq 'del(.metadata.vulnerabilities.high)' "$T/clean.json" >"$T/c-missing.json"
jq '.metadata.vulnerabilities.high="3"' "$T/clean.json" >"$T/c-str.json"
check "a High count of false fails closed"          1 "$T/c-false.json" "$T/allow.json" 2026-10-04
check "a negative Critical count fails closed"      1 "$T/c-neg.json" "$T/allow.json" 2026-10-04
check "a fractional High count fails closed"        1 "$T/c-frac.json" "$T/allow.json" 2026-10-04
check "a missing High count fails closed"           1 "$T/c-missing.json" "$T/allow.json" 2026-10-04
check "a string High count on a clean report fails" 1 "$T/c-str.json" "$T/allow.json" 2026-10-04

# An advisory with no url and no source is "unknown", and no entry may accept that.
jq '.vulnerabilities.foo={"severity":"high","via":[{"severity":"high","name":"foo"}]}' "$T/clean.json" >"$T/noid.json"
echo '[{"id":"unknown","reason":"x","expires":"2099-12-31"}]' >"$T/allow-unknown.json"
echo '[{"id":"unknown","package":"foo","reason":"x","expires":"2099-12-31"}]' >"$T/allow-unknown2.json"
echo '[{"id":"unknown:foo","package":"foo","reason":"x","expires":"2099-12-31"}]' >"$T/allow-unknown3.json"
check "an advisory with no id is not accepted by unknown"    1 "$T/noid.json" "$T/allow-unknown.json" 2026-10-04
check "unknown with a package does not accept it either"     1 "$T/noid.json" "$T/allow-unknown2.json" 2026-10-04
check "an unknown:<package> entry does not accept it"        1 "$T/noid.json" "$T/allow-unknown3.json" 2026-10-04

# An entry that names a package only accepts that package.
echo '[{"id":"GHSA-aaaa-bbbb-cccc","package":"other","reason":"x","expires":"2099-12-31"}]' >"$T/allow-otherpkg.json"
check "an entry for another package accepts nothing" 1 "$T/report.json" "$T/allow-otherpkg.json" 2026-10-04
echo '[{"id":"GHSA-aaaa-bbbb-cccc","reason":"x","expires":"2099-12-31"}]' >"$T/allow-nopkg.json"
check "an entry with no package still accepts the id" 0 "$T/report.json" "$T/allow-nopkg.json" 2026-10-04

# An empty package name or a newline in it must not shift columns or split a row.
jq '.vulnerabilities.braces.via[0].name=""' "$T/report.json" >"$T/emptyname.json"
jq '.vulnerabilities.braces.via[0].name="braces\nx"' "$T/report.json" >"$T/nlname.json"
jq '.vulnerabilities.braces.via[0].name="bra\tces"' "$T/report.json" >"$T/tabname.json"
check "an empty package name fails"                 1 "$T/emptyname.json" "$T/allow-nopkg.json" 2026-10-04
check "a newline in a package name fails"           1 "$T/nlname.json" "$T/allow-nopkg.json" 2026-10-04
check "a tab in a package name fails"               1 "$T/tabname.json" "$T/allow-nopkg.json" 2026-10-04
# check-action-pins.sh reads every form of a uses key and every composite action at any depth.
pins_check() { # name, expected rc, workflows dir
    local name=$1 want=$2; shift 2
    bash scripts/check-action-pins.sh "$@" >"$T/out" 2>&1; local got=$?
    if [ "$got" -eq "$want" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $name (rc $got, wanted $want)"; cat "$T/out"; fi
}
sha=3d3c42e5aac5ba805825da76410c181273ba90b1
for n in ok flow quoted nestedyml nestedyaml comment; do mkdir -p "$T/p-$n/workflows"; done
mkdir -p "$T/p-nestedyml/actions/a/b" "$T/p-nestedyaml/actions/a/b"
pinned=$(printf 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@%s # v7\n' "$sha")
for n in ok flow quoted nestedyml nestedyaml comment; do printf '%s\n' "$pinned" >"$T/p-$n/workflows/a.yml"; done
printf '      - {uses: actions/checkout@v4}\n' >>"$T/p-flow/workflows/a.yml"
printf '      - "uses": actions/checkout@v4\n' >>"$T/p-quoted/workflows/a.yml"
printf '      # uses: actions/setup-node@v4\n      - run: echo "- uses: x/y@v1"\n' >>"$T/p-comment/workflows/a.yml"
printf 'runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n' >"$T/p-nestedyml/actions/a/b/action.yml"
printf 'runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n' >"$T/p-nestedyaml/actions/a/b/action.yaml"
pins_check "every action pinned by SHA passes"         0 "$T/p-ok/workflows"
pins_check "a flow-style step with a tag fails"        1 "$T/p-flow/workflows"
pins_check "a quoted uses key with a tag fails"       1 "$T/p-quoted/workflows"
pins_check "a nested action.yml with a tag fails"      1 "$T/p-nestedyml/workflows"
pins_check "a nested action.yaml with a tag fails"     1 "$T/p-nestedyaml/workflows"
pins_check "comments and run text are not steps"       0 "$T/p-comment/workflows"
# Every uses key on a line is checked, not only the first.
mkdir -p "$T/p-mixed/workflows" "$T/p-two/workflows"
printf 'jobs:\n  a:\n    steps: [{uses: actions/checkout@%s}, {uses: actions/setup-node@v7}]\n' "$sha" >"$T/p-mixed/workflows/a.yml"
printf 'jobs:\n  a:\n    steps: [{uses: actions/checkout@%s}, {uses: actions/setup-node@%s}]\n' "$sha" "$sha" >"$T/p-two/workflows/a.yml"
pins_check "a later tag on a flow line fails"          1 "$T/p-mixed/workflows"
if bash scripts/check-action-pins.sh "$T/p-mixed/workflows" 2>&1 | grep -q 'actions/setup-node@v7'; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: the later tag is named"; fi
pins_check "two SHA-pinned flow maps pass"             0 "$T/p-two/workflows"
if bash scripts/check-action-pins.sh "$T/p-two/workflows" 2>&1 | grep -q '2 checked, 0 not pinned'; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: two flow maps count 2 checked"; fi
pins_check "this repository's workflows pass"          0 .github/workflows
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
