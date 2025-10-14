#!/usr/bin/env bash

# Updates (or creates) the changelog branch/PR for a given release branch.
# This script duplicates the logic of create_changelog_pr() from create-platform-release-pr.sh
# so it can run standalone (e.g. from automation) without sourcing the original script.
#
# Required arguments:
#   1. release_branch      - Name of the release branch (e.g., Version-v13.3.0, release/6.20.0)
#   2. platform            - Target platform (extension | mobile). Defaults to extension if empty.
#   3. repository_url      - Full HTTPS URL for the invoking repository.
#
# Optional arguments:
#   4. previous_version_ref - Previous version reference (branch/tag/SHA). Defaults to literal "null"
#                             so that commits.csv generation is skipped, matching hotfix behaviour.
#
# Environment (optional):
#   GH_TOKEN             - Token for GitHub CLI operations (falls back to gh auth config)
#   GIT_AUTHOR_NAME      - Commit author name (defaults to metamaskbot)
#   GIT_AUTHOR_EMAIL     - Commit author email (defaults to metamaskbot@users.noreply.github.com)
#   TEST_ONLY            - When set to "true" the helper mirrors release automation test mode.

set -euo pipefail

RELEASE_BRANCH="${1:?release branch is required}"
PLATFORM="${2:-extension}"
REPOSITORY_URL="${3:?repository url is required}"
PREVIOUS_VERSION_REF="${4:-null}"

AUTHOR_NAME="${GIT_AUTHOR_NAME:-metamaskbot}"
AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-metamaskbot@users.noreply.github.com}"
TEST_ONLY="${TEST_ONLY:-false}"

# --- Helper functions copied or adapted from create-platform-release-pr.sh ---

configure_git() {
    # Configure git identity and fetch remote refs so subsequent operations run
    # with the same context as create-platform-release-pr.sh.
    echo "Configuring git.."
    git config user.name "${AUTHOR_NAME}"
    git config user.email "${AUTHOR_EMAIL}"

    echo "Fetching from remote..."
    git fetch
}

checkout_or_create_branch() {
    # Ensure a branch exists locally for the changelog workflow. If it already
    # exists locally or remotely, check it out; otherwise create it (optionally
    # from a provided base branch) so changelog updates have the proper base.
    local branch_name="$1"
    local base_branch="${2:-}"

    echo "Checking for existing branch ${branch_name}"

    if git show-ref --verify --quiet "refs/heads/${branch_name}" || git ls-remote --heads origin "${branch_name}" | grep -q "${branch_name}"; then
        echo "Branch ${branch_name} already exists, checking it out"
        if git ls-remote --heads origin "${branch_name}" | grep -q "${branch_name}"; then
            git fetch origin "${branch_name}"
            git checkout "${branch_name}"
        else
            git checkout "${branch_name}"
        fi
    else
        echo "Creating new branch ${branch_name}"
        if [[ -n "${base_branch}" ]]; then
            git checkout "${base_branch}"
            git pull origin "${base_branch}"
        fi
        git checkout -b "${branch_name}"
    fi

    echo "Branch ${branch_name} ready"
}

push_branch_with_handling() {
    # Push changelog updates upstream, tolerating no-op pushes while still
    # surfacing failures when the remote branch is missing.
    local branch_name="$1"

    echo "Pushing changes to the remote.."
    if ! git push --set-upstream origin "${branch_name}"; then
        echo "No changes to push to ${branch_name}"
        if git ls-remote --heads origin "${branch_name}" | grep -q "${branch_name}"; then
            echo "Branch ${branch_name} already exists remotely"
        else
            echo "Error: Failed to push and branch doesn't exist remotely"
            exit 1
        fi
    fi
}

create_pr_if_not_exists() {
    # Guard against duplicate changelog PRs by checking existing PRs before
    # opening a draft that targets the release branch.
    local branch_name="$1"
    local title="$2"
    local body="$3"
    local base_branch="${4:-main}"
    local labels="${5:-}"
    local search_method="${6:-head}"

    echo "Creating PR for ${branch_name}.."

    local pr_exists=false
    if [[ "${search_method}" == "search" ]]; then
        if gh pr list --search "head:${branch_name}" --json number --jq 'length' | grep -q "1"; then
            pr_exists=true
        fi
    else
        if gh pr list --head "${branch_name}" --json number --jq 'length' | grep -q "1"; then
            pr_exists=true
        fi
    fi

    if ${pr_exists}; then
        echo "PR for branch ${branch_name} already exists"
    else
        local gh_cmd=(gh pr create --draft --title "${title}" --body "${body}" --base "${base_branch}" --head "${branch_name}")
        if [[ -n "${labels}" ]]; then
            gh_cmd+=(--label "${labels}")
        fi
        "${gh_cmd[@]}"
        echo "PR Created: ${title}"
    fi
}

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

generate_commits_csv_if_needed() {
    # Reproduce the release automation behaviour: for non-hotfix releases,
    # generate commits.csv using the github-tools helper so QA sheets can be
    # produced; skip entirely for hotfixes.
    local platform="$1"
    local previous_version_ref="$2"
    local release_branch="$3"

    if [[ "${previous_version_ref,,}" == "null" ]]; then
        echo "Hotfix release detected (previous-version-ref is 'null'); skipping commits.csv generation."
        return 0
    fi

    local project_git_dir
    project_git_dir=$(pwd)

    local diff_base="${previous_version_ref}"
    if [[ "${previous_version_ref}" =~ ^Version-v[0-9]+\.[0-9]+\.[0-9]+$ || "${previous_version_ref}" =~ ^release/[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Previous version looks like a release branch: ${previous_version_ref}"
        if git ls-remote --heads origin "${previous_version_ref}" | grep -q "."; then
            echo "Detected remote branch for previous version: ${previous_version_ref}"
            git fetch origin "${previous_version_ref}"
            diff_base="origin/${previous_version_ref}"
        else
            echo "Remote branch not found on origin: ${previous_version_ref}. Will use as-is."
        fi
    else
        echo "Previous version is not a recognized release branch pattern. Treating as tag or SHA: ${previous_version_ref}"
    fi

    pushd ./github-tools/ > /dev/null
    ls -ltra
    corepack prepare yarn@4.5.1 --activate
    yarn --cwd install

    echo "Generating test plan csv.."
    yarn run gen:commits "${platform}" "${diff_base}" "${release_branch}" "${project_git_dir}"
    popd > /dev/null
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
    if ! git commit -am "${commit_msg}"; then
        echo "No changes detected; skipping commit."
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

# Derive the semantic version from the branch naming convention.
if [[ "${RELEASE_BRANCH}" =~ ^Version-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
elif [[ "${RELEASE_BRANCH}" =~ ^release/([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
else
  echo "Release branch '${RELEASE_BRANCH}' does not match known patterns." >&2
  exit 0
fi

GITHUB_REPOSITORY_URL="${REPOSITORY_URL}"

configure_git

ensure_release_branch "${RELEASE_BRANCH}"

CHANGELOG_BRANCH=$(determine_changelog_branch "${VERSION}")
checkout_or_create_branch "${CHANGELOG_BRANCH}" "${RELEASE_BRANCH}"

echo "Generating changelog for ${PLATFORM} ${VERSION}.."
if [[ "${PLATFORM}" == "extension" ]]; then
    yarn auto-changelog update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${VERSION}" --autoCategorize --useChangelogEntry --useShortPrLink
else
    npx @metamask/auto-changelog@4.1.0 update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${VERSION}" --autoCategorize
fi

generate_commits_csv_if_needed "${PLATFORM}" "${PREVIOUS_VERSION_REF}" "${RELEASE_BRANCH}"

commit_and_push_changelog "${VERSION}" "${PREVIOUS_VERSION_REF}" "${CHANGELOG_BRANCH}" "${RELEASE_BRANCH}"

