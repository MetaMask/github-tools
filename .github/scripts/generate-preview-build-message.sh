#!/usr/bin/env bash

set -euo pipefail

# Generates a preview build PR comment message.
# Writes the message to preview-build-message.txt in the current directory.
#
# Usage: generate-preview-build-message.sh --monorepo|--polyrepo [--docs-url <url>]

docs_url=""
is_monorepo=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --monorepo)
      is_monorepo=true
      shift
      ;;
    --polyrepo)
      is_monorepo=false
      shift
      ;;
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

if [[ -z "$is_monorepo" ]]; then
  echo "::error::Must specify --monorepo or --polyrepo"
  exit 1
fi

docs_link=""
if [[ -n "$docs_url" ]]; then
  docs_link=" [See these instructions](${docs_url}) for more information about preview builds."
fi

if [[ "$is_monorepo" == "true" ]]; then
  # Build a JSON object of { name: version } for all non-root workspace packages.
  package_json="$(
    yarn workspaces list --no-private --json \
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
