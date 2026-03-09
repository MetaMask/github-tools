#!/usr/bin/env bash

set -euo pipefail

# This script prepares workspace packages to be published as preview builds.
# It renames packages to a preview NPM scope, sets prerelease versions, and
# reinstalls dependencies so that internal references resolve correctly.
#
# Usage: prepare-preview-builds.sh <npm_scope> <commit_hash> [source_scope]
#   npm_scope    - Target NPM scope (e.g., @metamask-previews)
#   commit_hash  - Short commit hash for the prerelease tag
#   source_scope - Source scope to replace (default: @metamask/)

if [[ $# -lt 2 ]]; then
  echo "::error::Usage: prepare-preview-builds.sh <npm_scope> <commit_hash> [source_scope]"
  exit 1
fi

npm_scope="$1"
commit_hash="$2"
source_scope="${3:-@metamask/}"

prepare-preview-manifest() {
  local manifest_file="$1"

  # Inline jq filter: rename scope and set prerelease version.
  # jq does not support in-place modification, so a temporary file is used.
  jq --raw-output \
    --arg npm_scope "$npm_scope" \
    --arg hash "$commit_hash" \
    --arg source_scope "$source_scope" \
    '
      .name |= sub($source_scope; "\($npm_scope)/") |
      .version |= (split("-")[0] + "-preview-\($hash)")
    ' \
    "$manifest_file" > temp.json
  mv temp.json "$manifest_file"
}

# Add resolutions to the root manifest so that imports under the source scope
# continue to resolve from the local workspace after packages are renamed to
# the preview scope. Without this, yarn resolves them from the npm registry,
# which causes build failures when workspace packages contain changes not yet
# published.
echo "Adding workspace resolutions to root manifest..."
resolutions="$(yarn workspaces list --no-private --json \
  | jq --slurp 'reduce .[] as $pkg ({}; .[$pkg.name] = "portal:./" + $pkg.location)')"
jq --argjson resolutions "$resolutions" '.resolutions = ((.resolutions // {}) + $resolutions)' package.json > temp.json
mv temp.json package.json

echo "Preparing manifests..."
while IFS=$'\t' read -r location name; do
  echo "- $name"
  prepare-preview-manifest "$location/package.json"
done < <(yarn workspaces list --no-private --json | jq --slurp --raw-output 'map([.location, .name]) | map(@tsv) | .[]')

echo "Installing dependencies..."
yarn install --no-immutable
