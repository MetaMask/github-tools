#!/usr/bin/env bash

set -e
set -u
set -o pipefail

PLATFORM="${1}"
PREVIOUS_VERSION="${2}"
NEW_VERSION="${3}"
NEW_VERSION_NUMBER="${4:-}"
RELEASE_BRANCH_PREFIX="release/"


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

# Returns the release branch name to use for the given platform
get_release_branch_name() {
    # Input arguments
    local platform="$1"       # Platform can be 'mobile' or 'extension'
    local new_version="$2"    # Semantic version, e.g., '12.9.2'

    local MOBILE_RELEASE_BRANCH_PREFIX="release/"
    # Common prefix for release branch
    local EXT_RELEASE_BRANCH_PREFIX="Version-v"

    # Logic for determining the release branch name
    if [[ "$platform" == "mobile" ]]; then
        # Mobile logic: RELEASE_BRANCH_NAME is straightforward
        #RELEASE_BRANCH_NAME="${MOBILE_RELEASE_BRANCH_PREFIX}/${new_version}"
        # TODO REMOVE THIS LINE AFTER TESTING
        RELEASE_BRANCH_NAME="release-testing/rls-mgmt"
    elif [[ "$platform" == "extension" ]]; then
        RELEASE_BRANCH_NAME="${EXT_RELEASE_BRANCH_PREFIX}${new_version}"
        # TODO Do we need the commit msg logic? Doesn't seem to align with how we do release PRs on mobile side
    else
        # Invalid platform: Print error message and terminate the script
        printf "Error: Unknown platform '%s'. Must be 'mobile' or 'extension'.\n" "$platform" >&2
        exit 1  # Exit the script with an error code
    fi

    # Output the release branch name
    echo "${RELEASE_BRANCH_NAME}"
}


RELEASE_BRANCH_NAME=$(get_release_branch_name $PLATFORM $NEW_VERSION)
CHANGELOG_BRANCH_NAME="chore/${NEW_VERSION}-Changelog"

# TODO DO WE HAVE A DIFFERENT RELEASE BODY FOR EXTENSION ?
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

echo "Configuring git.."
git config user.name metamaskbot
git config user.email metamaskbot@users.noreply.github.com

echo "Fetching from remote..."
git fetch

# TODO Remove
git status

# Check out the existing release branch from the remote
echo "Checking out the release branch: ${RELEASE_BRANCH_NAME}"
git checkout "${RELEASE_BRANCH_NAME}"

echo "Release Branch Checked Out"

echo "Running version update scripts.."
# Bump versions for the release
./scripts/set-semvar-version.sh "${NEW_VERSION}"
./scripts/set-build-version.sh "${NEW_VERSION_NUMBER}"


changed_files=$(get_expected_changed_files "$PLATFORM")

# Echo the files to be added
echo "Files to be staged for commit: $changed_files"

echo "Adding and committing changes.."

# Track our changes
git add $changed_files

# TODO Any requires on commit message format?
# Generate a commit
git commit -m "bump semvar version to ${NEW_VERSION} && build version to ${NEW_VERSION_NUMBER}"

echo "Pushing changes to the remote.."
git push --set-upstream origin "${RELEASE_BRANCH_NAME}"

echo Creating release PR..

gh pr create \
  --draft \
  --title "feat: ${NEW_VERSION}" \
  --body "${RELEASE_BODY}" \
  --head "${RELEASE_BRANCH_NAME}";

echo "Release PR Created"

git status


echo "Checking out ${CHANGELOG_BRANCH_NAME}"
git checkout -b "${CHANGELOG_BRANCH_NAME}"
echo "Changelog Branch Created"

# TODO Remove
head -n 20 CHANGELOG.md

echo -e "\nLast 20 lines of CHANGELOG.md:"
tail -n 20 CHANGELOG.md


echo "Generating changelog via auto-changelog.."

# Update changelog to reflect for our new version
npx @metamask/auto-changelog@2.1.0 update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${NEW_VERSION}"

echo "Generating test plan csv.."
node ./scripts/generate-rc-commits.mjs "${PREVIOUS_VERSION}" "${RELEASE_BRANCH_NAME}" 
# TODO CONFIRM WE DON'T INVOKE THIS ANYMORE
# ./scripts/changelog-csv.sh  "${RELEASE_BRANCH_NAME}" 

echo "Adding and committing changes.."
git add ./commits.csv

if ! (git commit -am "updated changelog and generated feature test plan");
then
    echo "Error: No changes detected."
    exit 1
fi

PR_BODY="This PR updates the change log for ${NEW_VERSION} and generates the test plan here [commit.csv](${GITHUB_REPOSITORY_URL}/blob/${RELEASE_BRANCH_NAME}/commits.csv)"

echo "Pushing changes to the remote.."
git push --set-upstream origin "${CHANGELOG_BRANCH_NAME}"

echo Creating release PR..
gh pr create \
  --draft \
  --title "chore: ${CHANGELOG_BRANCH_NAME}" \
  --body "${PR_BODY}" \
  --base "${RELEASE_BRANCH_NAME}" \
  --head "${CHANGELOG_BRANCH_NAME}";

echo "Changelog PR Created"