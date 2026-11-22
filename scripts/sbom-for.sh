#!/usr/bin/env bash
# Writes one package's CycloneDX SBOM to stdout, cut from a raw `npm sbom` of the workspace.
#
#   scripts/sbom-for.sh <raw-sbom.json> <package.json>
#
# npm names the repo root as the subject after the checkout folder and lists the workspace
# packages as components. This takes the package's own component as the subject (named from its
# package.json), keeps only what it depends on, directly or not, and drops the rest. It fails,
# with nothing on stdout, when the package is not in the SBOM or a declared dependency is missing
# from what it keeps.
set -uo pipefail

raw=${1:?usage: sbom-for.sh <raw-sbom.json> <package.json>}
pkg=${2:?usage: sbom-for.sh <raw-sbom.json> <package.json>}

if ! name=$(jq -er '.name | select(type == "string" and length > 0)' "$pkg") \
    || ! version=$(jq -er '.version | select(type == "string" and length > 0)' "$pkg"); then
    echo "sbom-for: $pkg has no name and version" >&2
    exit 1
fi
if ! want=$(jq -c '(.dependencies // {}) | keys' "$pkg"); then
    echo "sbom-for: cannot read dependencies of $pkg" >&2
    exit 1
fi
ref="$name@$version"

if ! out=$(jq --arg ref "$ref" --arg name "$name" --argjson want "$want" '
    def reach($g):
        {seen: [], todo: [.]}
        | until(.todo | length == 0;
            .todo[0] as $n | .todo |= .[1:]
            | if (.seen | index($n)) != null then .
              else .seen += [$n] | .todo += ($g[$n] // []) end)
        | .seen;
    . as $d
    | (if ($d | type) == "object" then . else error("the SBOM is not a JSON object") end)
    | (([$d.metadata.component] + ($d.components // [])) | map(select(. != null and .["bom-ref"] == $ref)) | first) as $subject
    | if $subject == null then error("no component with bom-ref \($ref) in the SBOM") else . end
    | (($d.dependencies // []) | map({key: .ref, value: (.dependsOn // [])}) | from_entries) as $graph
    | ($ref | reach($graph) | map(select(. != $ref))) as $closure
    | [($d.components // [])[] | select(.["bom-ref"] as $r | $closure | index($r) != null)] as $kept
    | ($want | map(select(. as $w | $kept | any(.name == $w or (((.group // "") + "/" + .name) == $w)) | not))) as $missing
    | if ($missing | length) > 0
      then error("dependencies of \($ref) missing from the SBOM: \($missing | join(", "))") else . end
    | .metadata.component = ($subject | .name = $name)
    | .components = $kept
    | .dependencies = [($d.dependencies // [])[] | select(.ref == $ref or (.ref as $r | $closure | index($r) != null))]
    ' "$raw" 2>"${TMPDIR:-/tmp}/sbom-for.$$"); then
    echo "sbom-for: $(cat "${TMPDIR:-/tmp}/sbom-for.$$")" >&2
    rm -f "${TMPDIR:-/tmp}/sbom-for.$$"
    exit 1
fi
rm -f "${TMPDIR:-/tmp}/sbom-for.$$"
printf '%s\n' "$out"
