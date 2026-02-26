#!/usr/bin/env bash

set -euo pipefail

# Generates a preview build PR comment message.
#
# Auto-detects monorepo vs polyrepo by checking for workspaces.
# Writes the message to preview-build-message.txt in the current directory.
#
# Usage: generate-preview-build-message.sh [--docs-url <url>]

docs_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docs-url)
      docs_url="$2"
      shift 2
      ;;
    *)
      echo "::error::Unknown argument: $1"
      exit 1
      ;;
  esac
done

# Detect monorepo by checking if yarn workspaces list returns any non-root packages.
is_monorepo=false
if workspace_json="$(yarn workspaces list --no-private --json 2>/dev/null)"; then
  non_root_count="$(echo "$workspace_json" | jq --slurp '[.[] | select(.location != ".")] | length')"
  if [[ "$non_root_count" -gt 0 ]]; then
    is_monorepo=true
  fi
fi

docs_link=""
if [[ -n "$docs_url" ]]; then
  docs_link=" [See these instructions](${docs_url}) for more information about preview builds."
fi

if [[ "$is_monorepo" == "true" ]]; then
  # Build a JSON object of { name: version } for all non-root workspace packages.
  package_json="$(
    echo "$workspace_json" \
      | jq --slurp '[.[] | select(.location != ".")] | .[].location' --raw-output \
      | while read -r location; do
          jq '{ (.name): .version }' "$location/package.json"
        done \
      | jq --slurp 'add'
  )"

  cat > preview-build-message.txt <<MSGEOF
Preview builds have been published.${docs_link}

<details>

<summary>Expand for full list of packages and versions.</summary>

\`\`\`
${package_json}
\`\`\`

</details>
MSGEOF
else
  # Polyrepo: single package in root.
  name="$(jq -r '.name' package.json)"
  version="$(jq -r '.version' package.json)"

  cat > preview-build-message.txt <<MSGEOF
Preview builds have been published.${docs_link}

\`\`\`
yarn add ${name}@${version}
\`\`\`
MSGEOF
fi

echo "Preview build message written to preview-build-message.txt"
