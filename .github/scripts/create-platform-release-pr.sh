#!/usr/bin/env bash

# Script to create platform release PRs for MetaMask
# This script handles the creation of release PRs for both mobile and extension platforms
# It creates two PRs:
# 1. A release PR with version updates
# 2. A changelog PR with updated changelog and test plan

set -e
set -u
set -o pipefail

# Input validation
PLATFORM="${1}"
PREVIOUS_VERSION="${2}"
NEW_VERSION="${3}"
NEW_VERSION_NUMBER="${4:-}"

# Validate required parameters
if [[ -z $PLATFORM ]]; then
  echo "Error: No platform specified."
  exit 1
fi

if [[ -z $NEW_VERSION ]]; then
  echo "Error: No new version specified."
  exit 1
fi

if [[ -z $NEW_VERSION_NUMBER && $PLATFORM == "mobile" ]]; then
  echo "Error: No new version number specified for mobile platform."
  exit 1
fi


# Helper Functions
# ---------------

# Returns a space-separated list of files that are expected to change for a given platform
get_expected_changed_files() {
  local platform="$1"
  local expected_changed_files=""

  if [[ "$platform" == "mobile" ]]; then
    expected_changed_files="package.json android/app/build.gradle ios/MetaMask.xcodeproj/project.pbxproj bitrise.yml"
  elif [[ "$platform" == "extension" ]]; then
    expected_changed_files="package.json"
  else
    echo "Error: Unknown platform '$platform'. Must be 'mobile' or 'extension'."
    exit 1
  fi

  echo "$expected_changed_files"
}

# Returns the release branch name based on platform and version
# For all platforms: release/{version}
# If TEST_ONLY=true: release-testing/{version}
get_release_branch_name() {
    local platform="$1"
    local new_version="$2"

    # Validate platform
    if [[ "$platform" != "mobile" && "$platform" != "extension" ]]; then
        echo "Error: Unknown platform '$platform'. Must be 'mobile' or 'extension'."
        exit 1
    fi

    # Use test branch if TEST_ONLY is true
    if [ "$TEST_ONLY" == "true" ]; then
        echo "release-testing/${new_version}"
        return 0
    fi

    # Use consistent release branch naming for all platforms
    echo "release/${new_version}"

    # Different release branch naming for different platforms, commented in case of need it
    # if [[ "$platform" == "mobile" ]]; then
    #   echo "release/${new_version}"
    # elif [[ "$platform" == "extension" ]]; then
    #   echo "Version-v${new_version}"
    # fi
}

# Main Script
# ----------

# Initialize branch names
RELEASE_BRANCH_NAME=$(get_release_branch_name $PLATFORM $NEW_VERSION)
CHANGELOG_BRANCH_NAME="chore/${NEW_VERSION}-Changelog"

# Prepare release PR body with team sign-off checklist
RELEASE_BODY="This is the release candidate for version ${NEW_VERSION}. The changelog will be found in another PR ${CHANGELOG_BRANCH_NAME}.

  # Team sign-off checklist
  - [ ] team-accounts
  - [ ] team-assets
  - [ ] team-confirmations
  - [ ] team-design-system
  - [ ] team-notifications
  - [ ] team-platform
  - [ ] team-security
  - [ ] team-snaps-platform
  - [ ] team-sdk
  - [ ] team-stake
  - [ ] team-tiger
  - [ ] team-wallet-framework

  # Reference
  - Testing plan sheet - https://docs.google.com/spreadsheets/d/1tsoodlAlyvEUpkkcNcbZ4PM9HuC9cEM80RZeoVv5OCQ/edit?gid=404070372#gid=404070372"

# Git Configuration
# ----------------
echo "Configuring git.."
git config user.name metamaskbot
git config user.email metamaskbot@users.noreply.github.com

echo "Fetching from remote..."
git fetch

# Release Branch Setup
# -------------------
echo "Checking out the release branch: ${RELEASE_BRANCH_NAME}"
git checkout "${RELEASE_BRANCH_NAME}"

echo "Release Branch Checked Out"

echo "version : ${NEW_VERSION}"
echo "platform : ${PLATFORM}"

# Version Updates
# --------------
echo "Running version update scripts.."
./github-tools/.github/scripts/set-semvar-version.sh "${NEW_VERSION}" ${PLATFORM}


# Commit Changes
# -------------
changed_files=$(get_expected_changed_files "$PLATFORM")
echo "Files to be staged for commit: $changed_files"

echo "Adding and committing changes.."

# Track our changes
git add $changed_files

# Generate commit message based on platform
if [ "$PLATFORM" = "mobile" ]; then
    if ! git commit -m "bump semvar version to ${NEW_VERSION} && build version to ${NEW_VERSION_NUMBER}"; then
        echo "No changes to commit for mobile version bump"
    fi
elif [ "$PLATFORM" = "extension" ]; then
    if ! git commit -m "bump semvar version to ${NEW_VERSION}"; then
        echo "No changes to commit for extension version bump"
    fi
fi

# Push Changes and Create Release PR
# ---------------------------------
echo "Pushing changes to the remote.."
if ! git push --set-upstream origin "${RELEASE_BRANCH_NAME}"; then
    echo "No changes to push to ${RELEASE_BRANCH_NAME}"
    # Check if branch exists remotely
    if git ls-remote --heads origin "${RELEASE_BRANCH_NAME}" | grep -q "${RELEASE_BRANCH_NAME}"; then
        echo "Branch ${RELEASE_BRANCH_NAME} already exists remotely"
    else
        echo "Error: Failed to push and branch doesn't exist remotely"
        exit 1
    fi
fi

echo "Creating release PR.."
# Check if PR already exists
if gh pr list --head "${RELEASE_BRANCH_NAME}" --json number --jq 'length' | grep -q "1"; then
    echo "PR for branch ${RELEASE_BRANCH_NAME} already exists"
else
    gh pr create \
      --draft \
      --title "release: ${NEW_VERSION}" \
      --body "${RELEASE_BODY}" \
      --head "${RELEASE_BRANCH_NAME}"
    echo "Release PR Created"
fi

# Changelog Branch Setup
# ---------------------
echo "Checking for existing changelog branch ${CHANGELOG_BRANCH_NAME}"

# Check if branch exists locally or remotely
if git show-ref --verify --quiet refs/heads/"${CHANGELOG_BRANCH_NAME}" || git ls-remote --heads origin "${CHANGELOG_BRANCH_NAME}" | grep -q "${CHANGELOG_BRANCH_NAME}"; then
    echo "Branch ${CHANGELOG_BRANCH_NAME} already exists, checking it out"
    git fetch origin "${CHANGELOG_BRANCH_NAME}"
    git checkout "${CHANGELOG_BRANCH_NAME}"
else
    echo "Creating new branch ${CHANGELOG_BRANCH_NAME}"
    git checkout -b "${CHANGELOG_BRANCH_NAME}"
fi
echo "Changelog Branch Ready"

# Generate Changelog and Test Plan
# ------------------------------
echo "Generating changelog via auto-changelog.."
npx @metamask/auto-changelog@4.1.0 update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${NEW_VERSION}" --autoCategorize

# Need to run from .github-tools context to inherit it's dependencies/environment
echo "Current Directory: $(pwd)"
PROJECT_GIT_DIR=$(pwd)
cd ./github-tools/
ls -ltra
corepack prepare yarn@4.5.1 --activate
# This can't be done from the actions context layer due to the upstream repository having it's own context set with yarn
yarn --cwd install

echo "Generating test plan csv.."
yarn run gen:commits "${PLATFORM}" "${PREVIOUS_VERSION}" "${RELEASE_BRANCH_NAME}" "${PROJECT_GIT_DIR}"

if [[ "${TEST_ONLY:-false}" == 'false' ]]; then
  echo "Updating release sheet.."
  # Create a new Release Sheet Page for the new version with our commits.csv content
  yarn run update-release-sheet "${PLATFORM}" "${NEW_VERSION}" "${GOOGLE_DOCUMENT_ID}" "./commits.csv" "${PROJECT_GIT_DIR}" "${MOBILE_TEMPLATE_SHEET_ID}" "${EXTENSION_TEMPLATE_SHEET_ID}"
fi
cd ../

# Commit and Push Changelog Changes
# -------------------------------
echo "Adding and committing changes.."
# Add commits.csv file if it exists
if [ -f "./commits.csv" ]; then
    echo "commits.csv found, adding to git..."
    git add ./commits.csv
else
    echo "--> commits.csv not found, skipping..."
fi


if ! (git commit -am "updated changelog and generated feature test plan");
then
    echo "Error: No changes detected."
    exit 1
fi

PR_BODY="This PR updates the change log for ${NEW_VERSION} and generates the test plan here [commit.csv](${GITHUB_REPOSITORY_URL}/blob/${CHANGELOG_BRANCH_NAME}/commits.csv)"

echo "Pushing changes to the remote.."
git push --set-upstream origin "${CHANGELOG_BRANCH_NAME}"

# Create Changelog PR
# -----------------
echo "Creating changelog PR.."
# Check if PR already exists
if gh pr list --search "head:${CHANGELOG_BRANCH_NAME}" --json number --jq 'length' | grep -q "1"; then
    echo "Changelog PR for branch ${CHANGELOG_BRANCH_NAME} already exists"
else
    gh pr create \
      --draft \
      --title "chore: ${CHANGELOG_BRANCH_NAME}" \
      --body "${PR_BODY}" \
      --base "${RELEASE_BRANCH_NAME}" \
      --head "${CHANGELOG_BRANCH_NAME}"
    echo "Changelog PR Created"
fi

echo "Changelog PR Ready"
