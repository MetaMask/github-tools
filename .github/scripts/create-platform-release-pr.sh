#!/usr/bin/env bash

# Script to create platform release PRs for MetaMask
# This script handles the creation of release PRs for both mobile and extension platforms
# It creates three PRs:
# 1. A release PR with version updates
# 2. A changelog PR with updated changelog and test plan (skipped in test mode)
# 3. A version bump PR for the main branch
#
# Usage:
#   create-platform-release-pr.sh <platform> <previous_version_ref> <new_version> [new_version_number] [git_user_name] [git_user_email]
#
# Parameters:
#   platform                - 'mobile' or 'extension'
#   previous_version_ref    - Previous release version branch name, tag or commit hash (e.g., release/7.7.0, v7.7.0, or 76fbc500034db9779e9ff7ce637ac5be1da0493d)
#   new_version             - New semantic version (e.g., 7.8.0)
#   new_version_number      - Build version for mobile platform (optional, required for mobile)
#   git_user_name           - Git user name for commits (optional, defaults to 'metamaskbot')
#   git_user_email          - Git user email for commits (optional, defaults to 'metamaskbot@users.noreply.github.com')

set -e
set -u
set -o pipefail

# Input validation
PLATFORM="${1}"
PREVIOUS_VERSION_REF="${2}"
NEW_VERSION="${3}"
NEW_VERSION_NUMBER="${4:-}"
GIT_USER_NAME="${5:-metamaskbot}"
GIT_USER_EMAIL="${6:-metamaskbot@users.noreply.github.com}"

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

if [[ -z $PREVIOUS_VERSION_REF ]]; then
  echo "Error: No previous version reference specified."
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

    # Different release branch naming for different platforms
    if [[ "$platform" == "mobile" ]]; then
      echo "release/${new_version}"
    elif [[ "$platform" == "extension" ]]; then
      local candidate_primary="Version-v${new_version}"
      local candidate_alt="release/${new_version}"
      # Prefer Version-v... if it exists on origin; otherwise use release/... if present; else default to Version-v...
      if git ls-remote --heads origin "${candidate_primary}" | grep -q "."; then
        echo "${candidate_primary}"
      elif git ls-remote --heads origin "${candidate_alt}" | grep -q "."; then
        echo "${candidate_alt}"
      else
        echo "${candidate_primary}"
      fi
    fi
}

# Calculate next version for main branch bump
get_next_version() {
    local current_version="$1"

    # Parse semantic version (major.minor.patch)
    if [[ ! $current_version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        echo "Error: Invalid semantic version format: $current_version" >&2
        exit 1
    fi

    local major="${BASH_REMATCH[1]}"
    local minor="${BASH_REMATCH[2]}"
    local patch="${BASH_REMATCH[3]}"

    # Increment minor version and reset patch to 0
    local next_minor=$((minor + 1))
    echo "${major}.${next_minor}.0"
}

# Returns the version bump branch name based on version and test mode
get_version_bump_branch_name() {
    local next_version="$1"

    # Use appropriate prefix based on test mode
    if [ "$TEST_ONLY" == "true" ]; then
        echo "version-bump-testing/${next_version}"
    else
        echo "version-bump/${next_version}"
    fi
}

# Main workflow functions
# -----------------------

# Helper function to check if branch exists and checkout/create it
checkout_or_create_branch() {
    local branch_name="$1"
    local base_branch="${2:-}" # Optional base branch for new branches

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
        if [[ -n "$base_branch" ]]; then
            git checkout "$base_branch"
            git pull origin "$base_branch"
        fi
        git checkout -b "${branch_name}"
    fi

    echo "Branch ${branch_name} ready"
}

# Helper function to push branch with error handling
push_branch_with_handling() {
    local branch_name="$1"

    echo "Pushing changes to the remote.."
    if ! git push --set-upstream origin "${branch_name}"; then
        echo "No changes to push to ${branch_name}"
        # Check if branch exists remotely
        if git ls-remote --heads origin "${branch_name}" | grep -q "${branch_name}"; then
            echo "Branch ${branch_name} already exists remotely"
        else
            echo "Error: Failed to push and branch doesn't exist remotely"
            exit 1
        fi
    fi
}

# Helper function to create PR if it doesn't exist
create_pr_if_not_exists() {
    local branch_name="$1"
    local title="$2"
    local body="$3"
    local base_branch="${4:-main}"
    local labels="${5:-}"
    local search_method="${6:-head}" # "head" or "search"

    echo "Creating PR for ${branch_name}.."

    # Check if PR already exists using different methods
    local pr_exists=false
    if [[ "$search_method" == "search" ]]; then
        if gh pr list --search "head:${branch_name}" --json number --jq 'length' | grep -q "1"; then
            pr_exists=true
        fi
    else
        if gh pr list --head "${branch_name}" --json number --jq 'length' | grep -q "1"; then
            pr_exists=true
        fi
    fi

    if $pr_exists; then
        echo "PR for branch ${branch_name} already exists"
    else
        # Build command array with conditional label inclusion
        local gh_cmd=(gh pr create --draft --title "${title}" --body "${body}" --base "${base_branch}" --head "${branch_name}")

        # Add labels only if provided (GitHub CLI doesn't accept empty label values)
        if [[ -n "${labels:-}" ]]; then
            gh_cmd+=(--label "${labels}")
        fi

        # Execute the command
        # echo "Executing: ${gh_cmd[@]}"
        "${gh_cmd[@]}"
        echo "PR Created: ${title}"
    fi
}

# Configure git for automation
configure_git() {
    echo "Configuring git.."
    git config user.name "${GIT_USER_NAME}"
    git config user.email "${GIT_USER_EMAIL}"

    echo "Fetching from remote..."
    git fetch
}

# Create release branch, update versions, and create PR
create_release_pr() {
    local platform="$1"
    local new_version="$2"
    local new_version_number="$3"
    local release_branch_name="$4"
    local changelog_branch_name="$5"

    echo "Checking out the release branch: ${release_branch_name}"
    git checkout "${release_branch_name}"

    echo "Release Branch Checked Out"
    echo "version : ${new_version}"
    echo "platform : ${platform}"

    # Version Updates
    echo "Running version update scripts.."
    ./github-tools/.github/scripts/set-semvar-version.sh "${new_version}" "${platform}"

    # Commit Changes
    local changed_files
    changed_files=$(get_expected_changed_files "$platform")
    echo "Files to be staged for commit: $changed_files"

    echo "Adding and committing changes.."
    git add $changed_files

    # Generate commit message based on platform
    if [ "$platform" = "mobile" ]; then
        if ! git commit -m "bump semvar version to ${new_version} && build version to ${new_version_number}"; then
            echo "No changes to commit for mobile version bump"
        fi
    elif [ "$platform" = "extension" ]; then
        if ! git commit -m "bump semvar version to ${new_version}"; then
            echo "No changes to commit for extension version bump"
        fi
    fi

    # Prepare release PR body with team sign-off checklist
    local release_body="This is the release candidate for version ${new_version}. The changelog will be found in another PR ${changelog_branch_name}.

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

    # Push and create PR using helper functions
    push_branch_with_handling "${release_branch_name}"
    create_pr_if_not_exists "${release_branch_name}" "release: ${new_version}" "${release_body}" "${BASE_BRANCH}" "" "head"
}

# Create changelog branch and generate changelog
create_changelog_pr() {
    local platform="$1"
    local new_version="$2"
    local previous_version_ref="$3"
    local release_branch_name="$4"
    local changelog_branch_name="$5"

    # Use helper function for branch checkout/creation
    checkout_or_create_branch "${changelog_branch_name}"

    # Generate Changelog and Test Plan
    echo "Generating changelog via auto-changelog.."
    npx @metamask/auto-changelog@4.1.0 update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${new_version}" --autoCategorize

    # Need to run from .github-tools context to inherit it's dependencies/environment
    echo "Current Directory: $(pwd)"
    PROJECT_GIT_DIR=$(pwd)

    # By default, DIFF_BASE is set to the provided `previous_version_ref` (which can be a branch name, tag, or commit hash).
    # If `previous_version_ref` matches a remote branch on origin, we fetch it and update DIFF_BASE to the fully qualified remote ref (`origin/<branch>`).
    # This is required for the `generate-rc-commits.mjs` script to resolve the branch and successfully run the `git log` command.
    # Otherwise, DIFF_BASE remains unchanged.
    DIFF_BASE="${previous_version_ref}"

    # Only consider known release branch patterns to avoid regex pitfalls:
    # - Extension: Version-vx.y.z
    # - Mobile:    release/x.y.z
    if [[ "${previous_version_ref}" =~ ^Version-v[0-9]+\.[0-9]+\.[0-9]+$ || "${previous_version_ref}" =~ ^release/[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Previous version looks like a release branch: ${previous_version_ref}"
      # Check if the exact branch exists on origin without interpolating into a regex
      if git ls-remote --heads origin "${previous_version_ref}" | grep -q "."; then
        echo "Detected remote branch for previous version: ${previous_version_ref}"
        git fetch origin "${previous_version_ref}"
        DIFF_BASE="origin/${previous_version_ref}"
      else
        echo "Remote branch not found on origin: ${previous_version_ref}. Will use as-is."
      fi
    else
      echo "Previous version is not a recognized release branch pattern. Treating as tag or SHA: ${previous_version_ref}"
    fi

    # Switch to github-tools directory
    cd ./github-tools/
    ls -ltra
    corepack prepare yarn@4.5.1 --activate
    # This can't be done from the actions context layer due to the upstream repository having it's own context set with yarn
    yarn --cwd install

    echo "Generating test plan csv.."
    yarn run gen:commits "${platform}" "${DIFF_BASE}" "${release_branch_name}" "${PROJECT_GIT_DIR}"
    
    # Skipping Google Sheets update since there is no need for it anymore
    # TODO: Remove this once the current post-main validation approach is stable
    # if [[ "${TEST_ONLY:-false}" == 'false' ]]; then
    #   echo "Updating release sheet.."
    #   # Create a new Release Sheet Page for the new version with our commits.csv content
    #   yarn run update-release-sheet "${platform}" "${new_version}" "${GOOGLE_DOCUMENT_ID}" "./commits.csv" "${PROJECT_GIT_DIR}" "${MOBILE_TEMPLATE_SHEET_ID}" "${EXTENSION_TEMPLATE_SHEET_ID}"
    # fi
    cd ../

    # Commit and Push Changelog Changes (exclude commits.csv)
    echo "Adding and committing changes.."
    if ! (git commit -am "update changelog for ${new_version}"); then
        echo "Error: No changes detected."
        exit 1
    fi

    local pr_body="This PR updates the change log for ${new_version}."

    # Use helper functions for push and PR creation
    push_branch_with_handling "${changelog_branch_name}"
    create_pr_if_not_exists "${changelog_branch_name}" "chore: ${changelog_branch_name}" "${pr_body}" "${release_branch_name}" "" "search"

    echo "Changelog PR Ready"
}

# Create version bump PR for main branch
create_version_bump_pr() {
    local platform="$1"
    local new_version="$2"
    local next_version="$3"
    local version_bump_branch_name="$4"
    local release_branch_name="$5"
    local main_branch="${6:-main}"  # Default to 'main' if not provided

    echo "Creating main version bump PR.."

    # Use helper function for branch checkout/creation with base branch
    checkout_or_create_branch "${version_bump_branch_name}" "${main_branch}"

    # Update version files on main branch
    echo "Running version update scripts for ${main_branch} branch.."
    ./github-tools/.github/scripts/set-semvar-version.sh "${next_version}" "${platform}"

    # Commit version bump changes
    echo "Committing version bump changes.."
    local changed_files
    changed_files=$(get_expected_changed_files "$platform")
    git add $changed_files

    if git diff --staged --quiet; then
        echo "No changes to commit for version bump"
    else
        git commit -m "release: Bump version to ${next_version} after release ${new_version}

This automated version bump ensures that:
- ${main_branch} branch version is ahead of the release branch
- Future nightly builds will have correct versioning

Release version: ${new_version}
New ${main_branch} version: ${next_version}
Platform: ${platform}"
        echo "Version bump committed"
    fi

    # If the version bump branch has no commits ahead of main, skip pushing/PR creation
    # Validate refs before computing ahead count to avoid masking errors
    # Fail fast with a error message if the base branch doesn’t exist locally (or isn’t fetched)
    # Verifies that ${main_branch} exists and resolves to a valid commit and not a tag, tree, or something else
    if ! git rev-parse --verify --quiet "${main_branch}^{commit}" >/dev/null; then
        echo "Error: Base branch does not resolve to a commit: ${main_branch}"
        exit 1
    fi
    # Fail fast with a error message if the version bump branch doesn’t exist locally (or isn’t fetched)
    # Verifies that ${version_bump_branch_name} exists and resolves to a valid commit and not a tag, tree, or something else
    if ! git rev-parse --verify --quiet "${version_bump_branch_name}^{commit}" >/dev/null; then
        echo "Error: Version bump branch does not resolve to a commit: ${version_bump_branch_name}"
        exit 1
    fi
    # right-only count gives number of commits unique to the version bump branch
    ahead_count=$(git rev-list --right-only --count "${main_branch}...${version_bump_branch_name}")
    if [ "${ahead_count}" -eq 0 ]; then
        echo "No differences between ${main_branch} and ${version_bump_branch_name}; skipping version bump PR creation."
        return 0
    fi

    local version_bump_body="## Version Bump After Release

This PR bumps the ${main_branch} branch version from ${new_version} to ${next_version} after cutting the release branch.

### Why this is needed:
- **Nightly builds**: Each nightly build needs to be one minor version ahead of the current release candidate
- **Version conflicts**: Prevents conflicts between nightlies and release candidates
- **Platform alignment**: Maintains version alignment between MetaMask mobile and extension
- **Update systems**: Ensures nightlies are accepted by app stores and browser update systems

### What changed:
- Version bumped from \`${new_version}\` to \`${next_version}\`
- Platform: \`${platform}\`
- Files updated by \`set-semvar-version.sh\` script

### Next steps:
This PR should be **manually reviewed and merged by the release manager** to maintain proper version flow.

### Related:
- Release version: ${new_version}
- Release branch: ${release_branch_name}
- Platform: ${platform}
- Test mode: ${TEST_ONLY}

---
*This PR was automatically created by the \`create-platform-release-pr.sh\` script.*"

    # Use helper functions for push and PR creation
    push_branch_with_handling "${version_bump_branch_name}"
    create_pr_if_not_exists "${version_bump_branch_name}" "release: Bump ${main_branch} version to ${next_version}" "${version_bump_body}" "${main_branch}" "" "head"

    echo "Version bump PR ready"
}

# Main orchestration function
main() {
    # Calculate next version for main branch bump
    local next_version
    next_version=$(get_next_version "$NEW_VERSION")

    # Initialize branch names
    local release_branch_name changelog_branch_name version_bump_branch_name
    release_branch_name=$(get_release_branch_name "$PLATFORM" "$NEW_VERSION")
    changelog_branch_name="chore/${NEW_VERSION}-Changelog"
    version_bump_branch_name=$(get_version_bump_branch_name "$next_version")    # Execute main workflow
    configure_git

    # Step 1: Create release branch and PR
    create_release_pr "$PLATFORM" "$NEW_VERSION" "$NEW_VERSION_NUMBER" "$release_branch_name" "$changelog_branch_name"

    # Step 2: Create changelog PR (skip in test mode)
    if [ "$TEST_ONLY" == "true" ]; then
        echo "Skipping changelog generation in test mode"
    else
        create_changelog_pr "$PLATFORM" "$NEW_VERSION" "$PREVIOUS_VERSION_REF" "$release_branch_name" "$changelog_branch_name"
    fi

    # Step 3: Create version bump PR for main branch
    create_version_bump_pr "$PLATFORM" "$NEW_VERSION" "$next_version" "$version_bump_branch_name" "$release_branch_name" "main"

    # Final summary
    echo ""
    echo "========================================="
    echo "Release automation complete!"
    echo "========================================="
    echo "Created PRs:"
    echo "1. Release PR: release: ${NEW_VERSION}"
    if [ "$TEST_ONLY" != "true" ]; then
        echo "2. Changelog PR: chore: ${changelog_branch_name}"
        echo "3. Version bump PR: Bump main version to ${next_version}"
    else
        echo "2. Version bump PR: Bump main version to ${next_version} (test mode - changelog skipped)"
    fi
    echo "========================================="
}

# Execute main function only if script is run directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
