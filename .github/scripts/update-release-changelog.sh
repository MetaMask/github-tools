#!/usr/bin/env bash

# Updates (or creates) the changelog branch/PR for a given release branch.
# This script duplicates the logic of create_changelog_pr() from create-platform-release-pr.sh
# so it can run standalone (e.g. from automation) without sourcing the original script.
#
# Required arguments:
#   1. release_branch      - Name of the release branch (e.g., release/6.20.0)
#   2. platform            - Target platform (extension | mobile). Defaults to extension if empty.
#   3. repository_url      - Full HTTPS URL for the invoking repository.
#
# Optional arguments:
#   4. previous_version_ref - Previous version reference (branch/tag/SHA). Defaults to literal "null"
#                             so that commits.csv generation is skipped, matching hotfix behaviour.
#
# Environment (optional):
#   GITHUB_TOKEN         - Token for GitHub CLI operations (falls back to gh auth config)
#   GIT_AUTHOR_NAME      - Commit author name (defaults to metamaskbot)
#   GIT_AUTHOR_EMAIL     - Commit author email (defaults to metamaskbot@users.noreply.github.com)
#   TEST_ONLY            - When set to "true" the helper mirrors release automation test mode.

set -euo pipefail

# Sourcing helper functions
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=.github/scripts/utils.sh
source "${SCRIPT_DIR}/utils.sh"

RELEASE_BRANCH="${1:?release branch is required}"
PLATFORM="${2:-extension}"
REPOSITORY_URL="${3:?repository url is required}"
PREVIOUS_VERSION_REF="${4:-null}"

AUTHOR_NAME="${GIT_AUTHOR_NAME:-metamaskbot}"
AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-metamaskbot@users.noreply.github.com}"
TEST_ONLY="${TEST_ONLY:-false}"

# -----------------------------------------------------------------
# -----------------------------------------------------------------

# --- Local helper functions specific to this script ---

ensure_release_branch() {
    # Sync the release branch to the latest remote state so changelog commits
    # build off the current release tip.
    local release_branch="$1"
    git fetch origin "${release_branch}"
    git checkout "${release_branch}"
    git reset --hard "origin/${release_branch}"
}

determine_changelog_branch() {
    # Prefer an existing remote changelog branch (release/<version>-Changelog),
    # falling back to the chore/ naming or the preferred default if none exist.
    local version="$1"
    local preferred="release/${version}-Changelog"
    if git ls-remote --exit-code origin "${preferred}" > /dev/null 2>&1; then
        echo "${preferred}"
    elif git ls-remote --exit-code origin "chore/${version}-Changelog" > /dev/null 2>&1; then
        echo "chore/${version}-Changelog"
    else
        echo "${preferred}"
    fi
}


commit_and_push_changelog() {
    # Commit changelog updates (with the same messaging as the release script),
    # push the branch, and ensure a draft PR exists targeting the release branch.
    local version="$1"
    local previous_version_ref="$2"
    local changelog_branch="$3"
    local release_branch="$4"

    echo "Adding and committing changes.."
    local commit_msg="update changelog for ${version}"
    if [[ "${previous_version_ref,,}" == "null" ]]; then
        commit_msg="${commit_msg} (hotfix - no test plan)"
    fi
    
    local changes_committed=false
    if git commit -am "${commit_msg}"; then
        changes_committed=true
    else
        echo "No changes detected; skipping commit."
    fi

    # Check if there are any differences between the changelog branch and release branch
    if ! ${changes_committed}; then
        echo "Checking for differences between ${changelog_branch} and ${release_branch}.."
        if ! git diff --quiet "origin/${release_branch}" "HEAD"; then
            echo "Differences found between branches; proceeding with PR creation."
        else
            echo "No differences between ${changelog_branch} and ${release_branch}."
            echo "Branches are already in sync; skipping PR creation."
            echo "Changelog workflow completed successfully (no updates needed)."
            return 0
        fi
    fi

    local pr_body="This PR updates the change log for ${version}."
    if [[ "${previous_version_ref,,}" == "null" ]]; then
        pr_body="${pr_body} (Hotfix - no test plan generated.)"
    fi

    push_branch_with_handling "${changelog_branch}"
    create_pr_if_not_exists "${changelog_branch}" "release: ${changelog_branch}" "${pr_body}" "${release_branch}" "" "search"
    echo "Changelog PR Ready"
}

# -----------------------------------------------------------------

# Derive the semantic version from the branch naming convention (release/x.y.z only).
if [[ "${RELEASE_BRANCH}" =~ ^release/([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
else
  echo "Release branch '${RELEASE_BRANCH}' does not match known patterns." >&2
  exit 1
fi

GITHUB_REPOSITORY_URL="${REPOSITORY_URL}"

configure_git "${AUTHOR_NAME}" "${AUTHOR_EMAIL}"

ensure_release_branch "${RELEASE_BRANCH}"

CHANGELOG_BRANCH=$(determine_changelog_branch "${VERSION}")
checkout_or_create_branch "${CHANGELOG_BRANCH}" "${RELEASE_BRANCH}"

echo "Generating changelog for ${PLATFORM} ${VERSION}.."

yarn auto-changelog update --rc \
    --repo "${GITHUB_REPOSITORY_URL}" \
    --currentVersion "${VERSION}" \
    --autoCategorize \
    --useChangelogEntry \
    --useShortPrLink \
    --requirePrNumbers

# commits.csv generation removed (no longer required)

commit_and_push_changelog "${VERSION}" "${PREVIOUS_VERSION_REF}" "${CHANGELOG_BRANCH}" "${RELEASE_BRANCH}"
