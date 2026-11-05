#!/usr/bin/env bash

# Deprecated: forwards the old positional interface to update-release-changelog.mts
# for callers that still run this script from a github-tools checkout (for example
# Mobile's wrapper). Use the `update-release-changelog` action instead.
#
# Arguments, unchanged from before:
#   1. release_branch       - Release branch name (required)
#   2. platform             - extension | mobile (defaults to extension)
#   3. repository_url       - Full HTTPS URL of the invoking repository (required)
#   4. previous_version_ref - Accepted and ignored
#   5. changelog_branch     - Changelog branch name (optional)
#   6. version              - Semantic version (optional, derived from the branch)
#
# Runs in the current directory, which must be a checkout of the invoking repository.

set -euo pipefail

RELEASE_BRANCH="${1:?release branch is required}"
PLATFORM="${2:-extension}"
REPOSITORY_URL="${3:?repository url is required}"
CHANGELOG_BRANCH_INPUT="${5:-}"
VERSION_INPUT="${6:-}"

GITHUB_TOOLS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The updater is TypeScript that Node runs directly, which needs type stripping.
node_version="$(node --version)"
IFS=. read -r node_major node_minor _ <<<"${node_version#v}"
if (( node_major < 22 || (node_major == 22 && node_minor < 18) )); then
  echo "Error: update-release-changelog needs Node 22.18 or newer, found ${node_version}" >&2
  exit 1
fi

# Corepack resolves Yarn from the working directory, so install from the
# github-tools root to use its own pinned Yarn and lockfile.
(
  cd "$GITHUB_TOOLS_ROOT"
  corepack enable
  corepack yarn install --immutable
)

export AUTO_CHANGELOG_CLI="${GITHUB_TOOLS_ROOT}/node_modules/@metamask/auto-changelog/dist/cli.js"

exec node "${GITHUB_TOOLS_ROOT}/.github/scripts/update-release-changelog.mts" \
  "$RELEASE_BRANCH" \
  "$PLATFORM" \
  "$REPOSITORY_URL" \
  "$CHANGELOG_BRANCH_INPUT" \
  "$VERSION_INPUT"
