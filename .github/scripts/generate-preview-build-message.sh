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
  docs_link="[See these instructions](${docs_url}) for more information about preview builds."
fi

if [[ "$is_monorepo" == "true" ]]; then
  # Build a list of "name@version" for all workspace packages.
  packages="$(
    yarn workspaces list --no-private --json \
      | jq --raw-output '.location' \
      | xargs -I{} cat '{}/package.json' \
      | jq --raw-output '"\(.name)@\(.version)"'
  )"

  echo -n "Preview builds have been published." > preview-build-message.txt
  if [[ -n "$docs_link" ]]; then
    echo -n " ${docs_link}" >> preview-build-message.txt
  fi
  cat <<-MSGEOF >> preview-build-message.txt

<details>
<summary>Expand for full list of packages and versions.</summary>

\`\`\`
${packages}
\`\`\`

</details>
MSGEOF
else
  # Polyrepo: single package in root.
  name="$(jq -r '.name' package.json)"
  version="$(jq -r '.version' package.json)"

  cat <<-MSGEOF > preview-build-message.txt
The following preview build has been published:

\`\`\`
${name}@${version}
\`\`\`
MSGEOF
  if [[ -n "$docs_link" ]]; then
    cat <<-MSGEOF >> preview-build-message.txt

${docs_link}
MSGEOF
  fi
fi

echo "Preview build message written to preview-build-message.txt"
