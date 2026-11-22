#!/usr/bin/env bash
# Checks scripts/sbom-for.sh against a raw SBOM shaped like `npm sbom -w cli` output.
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; }

cat >"$T/raw.json" <<'J'
{"bomFormat":"CycloneDX","specVersion":"1.5","version":1,
 "metadata":{"timestamp":"2026-01-01T00:00:00Z","component":{"bom-ref":"@baryodev/barako-client@0.6.0","type":"library","name":"client-sec-ci","version":"0.6.0"}},
 "components":[
  {"bom-ref":"@baryodev/barako@0.1.0","type":"library","name":"cli","version":"0.1.0"},
  {"bom-ref":"@baryodev/barako-client@0.5.0","type":"library","name":"@baryodev/barako-client","version":"0.5.0"}],
 "dependencies":[
  {"ref":"@baryodev/barako-client@0.6.0","dependsOn":[]},
  {"ref":"@baryodev/barako@0.1.0","dependsOn":["@baryodev/barako-client@0.5.0"]},
  {"ref":"@baryodev/barako-client@0.5.0","dependsOn":[]}]}
J
echo '{"name":"@baryodev/barako-client","version":"0.6.0"}' >"$T/client.json"
echo '{"name":"@baryodev/barako","version":"0.1.0","dependencies":{"@baryodev/barako-client":">=0.5.0 <0.7.0"}}' >"$T/cli.json"

# The client SBOM names the client, lists nothing it does not ship, and keeps its own graph entry.
if out=$(bash scripts/sbom-for.sh "$T/raw.json" "$T/client.json" 2>"$T/err") \
    && jq -e '.metadata.component["bom-ref"] == "@baryodev/barako-client@0.6.0"
              and .metadata.component.name == "@baryodev/barako-client"
              and (.components | length) == 0 and (.dependencies | length) == 1
              and .metadata.timestamp == "2026-01-01T00:00:00Z"' <<<"$out" >/dev/null; then ok; else bad "the client SBOM has its own name, no components and one dependencies entry"; fi

# The CLI SBOM is about the CLI and holds only the client it depends on.
if out=$(bash scripts/sbom-for.sh "$T/raw.json" "$T/cli.json" 2>"$T/err") \
    && jq -e '.metadata.component["bom-ref"] == "@baryodev/barako@0.1.0"
              and .metadata.component.name == "@baryodev/barako"
              and (.components | map(.["bom-ref"])) == ["@baryodev/barako-client@0.5.0"]
              and (.dependencies | length) == 2' <<<"$out" >/dev/null; then ok; else bad "the CLI SBOM names the CLI and has one component"; fi

# Failures print nothing on stdout and exit 1.
fails() { # name, raw, package.json
    local out rc
    out=$(bash scripts/sbom-for.sh "$2" "$3" 2>"$T/err"); rc=$?
    if [ "$rc" -eq 1 ] && [ -z "$out" ] && [ -s "$T/err" ]; then ok; else bad "$1 (rc $rc, stdout ${#out} bytes)"; fi
}
echo '{"name":"@baryodev/other","version":"1.0.0"}' >"$T/other.json"
fails "a package that is not in the SBOM fails" "$T/raw.json" "$T/other.json"
echo '{"name":"@baryodev/barako","version":"0.1.0","dependencies":{"left-pad":"^1.0.0"}}' >"$T/missing.json"
fails "a dependency missing from the closure fails" "$T/raw.json" "$T/missing.json"
echo '{' >"$T/invalid.json"
fails "invalid JSON fails" "$T/invalid.json" "$T/client.json"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
