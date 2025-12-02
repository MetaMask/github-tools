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

# Input assignments (quoted args prevent shifting). Use defaults only for optional args.
PLATFORM="${1}"
PREVIOUS_VERSION_REF="${2:-}"
# Normalize whitespace-only values; hotfixes are indicated by the literal string 'null'
PREVIOUS_VERSION_REF="${PREVIOUS_VERSION_REF//[[:space:]]/}"
NEW_VERSION="${3}"
NEW_VERSION="${NEW_VERSION//[[:space:]]/}"
NEW_VERSION_NUMBER="${4:-}"
GIT_USER_NAME="${5:-metamaskbot}"
GIT_USER_EMAIL="${6:-metamaskbot@users.noreply.github.com}"

# Log assigned variables for debugging (after defaults and trimming)
echo "Assigned variables:"
echo "PLATFORM: $PLATFORM"
echo "PREVIOUS_VERSION_REF: $PREVIOUS_VERSION_REF"
echo "NEW_VERSION: $NEW_VERSION"
echo "NEW_VERSION_NUMBER: $NEW_VERSION_NUMBER"
echo "GIT_USER_NAME: $GIT_USER_NAME"
echo "GIT_USER_EMAIL: $GIT_USER_EMAIL"

# Validate required parameters (allow empty PREVIOUS_VERSION_REF for hotfixes)
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
    local new_version="$1"

    # Use test branch if TEST_ONLY is true
    if [ "$TEST_ONLY" == "true" ]; then
        echo "release-testing/${new_version}"
        return 0
    fi

    echo "release/${new_version}"
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

    local platform_team_name
    if [ "$platform" = "extension" ]; then
        platform_team_name="Extension Platform"
    elif [ "$platform" = "mobile" ]; then
        platform_team_name="Mobile Platform"
    else
        echo "Error: Unknown platform '$platform'. Must be 'extension' or 'mobile'."
        exit 1
    fi

    # Prepare release PR body with team sign-off checklist
    local release_body="# 🚀 v${new_version} Testing & Release Quality Process

Hi Team,  
As part of our new **MetaMask Release Quality Process**, here’s a quick overview of the key processes, testing strategies, and milestones to ensure a smooth and high-quality deployment.

---

## 📋 Key Processes

### Testing Strategy
- **Developer Teams:**  
  Conduct regression and exploratory testing for your functional areas, including automated and manual tests for critical workflows.  
- **QA Team:**  
  Focus on exploratory testing across the wallet, prioritize high-impact areas, and triage any Sentry errors found during testing.  
- **Customer Success Team:**  
  Validate new functionalities and provide feedback to support release monitoring.

### GitHub Signoff
- Each team must **sign off on the Release Candidate (RC)** via GitHub by the end of the validation timeline (**Tuesday EOD PT**).  
- Ensure all tests outlined in the Testing Plan are executed, and any identified issues are addressed.

### Issue Resolution
- **Resolve all Release Blockers** (Sev0 and Sev1) by **Tuesday EOD PT**.  
- For unresolved blockers, PRs may be reverted, or feature flags disabled to maintain release quality and timelines.

### Cherry-Picking Criteria
- Only **critical fixes** meeting outlined criteria will be cherry-picked.  
- Developers must ensure these fixes are thoroughly reviewed, tested, and merged by **Tuesday EOD PT**.

---

## 🗓️ Timeline and Milestones

1. **Today (Friday):** Begin Release Candidate validation.  
2. **Tuesday EOD PT:** Finalize RC with all fixes and cherry-picks.  
3. **Wednesday:** Buffer day for final checks.  
4. **Thursday:** Submit release to app stores and begin rollout to 1% of users.  
5. **Monday:** Scale deployment to 10%.  
6. **Tuesday:** Full rollout to 100%.

---

## ✅ Signoff Checklist

Each team is responsible for signing off via GitHub. Use the checkbox below to track signoff completion:

# Team sign-off checklist
- [ ] ${platform_team_name}

This process is a major step forward in ensuring release stability and quality. Let’s stay aligned and make this release a success! 🚀  

Feel free to reach out if you have questions or need clarification. 

Many thanks in advance

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

    # Generate Changelog (skip in test mode to avoid PR lookup errors in fork/test repos)
    if [ "$TEST_ONLY" == "true" ]; then
        echo "Skipping auto-changelog generation in test mode (PR lookups would fail in fork/test repos)"
    else
        echo "Generating changelog for ${platform}.."
        yarn auto-changelog update --rc --repo "${GITHUB_REPOSITORY_URL}" --currentVersion "${new_version}" --autoCategorize --useChangelogEntry --useShortPrLink
    fi


    # Skip commits.csv for hotfix releases (previous_version_ref is literal "null")
    # - When we create a new major/minor release, we fetch all commits included in the release, by fetching the diff between HEAD and previous version reference.
    # - When we create a new hotfix release, there are no commits included in the release by default (they will be cherry-picked one by one). So we don't have previous version reference, which is why the value is set to 'null'.
    if [[ "${previous_version_ref,,}" == "null" ]]; then
      echo "Hotfix release detected (previous-version-ref is 'null'); skipping commits.csv generation."
    else
      # Need to run from .github-tools context to inherit it's dependencies/environment
      echo "Current Directory: $(pwd)"
      PROJECT_GIT_DIR=$(pwd)

      # By default, DIFF_BASE is set to the provided `previous_version_ref` (which can be a branch name, tag, or commit hash).
      # If `previous_version_ref` matches a remote branch on origin, we fetch it and update DIFF_BASE to the fully qualified remote ref (`origin/<branch>`).
      # This is required for the `generate-rc-commits.mjs` script to resolve the branch and successfully run the `git log` command.
      # Otherwise, DIFF_BASE remains unchanged.
      DIFF_BASE="${previous_version_ref}"

      # Only consider known release branch patterns to avoid regex pitfalls: release/x.y.z
      if [[ "${previous_version_ref}" =~ ^release/[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
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
      # Return to project root after generating commits.csv
      cd ../
    fi

    # Skipping Google Sheets update since there is no need for it anymore
    # TODO: Remove this once the current post-main validation approach is stable
    # if [[ "${TEST_ONLY:-false}" == 'false' ]]; then
    #   echo "Updating release sheet.."
    #   # Create a new Release Sheet Page for the new version with our commits.csv content
    #   yarn run update-release-sheet "${platform}" "${new_version}" "${GOOGLE_DOCUMENT_ID}" "./commits.csv" "${PROJECT_GIT_DIR}" "${MOBILE_TEMPLATE_SHEET_ID}" "${EXTENSION_TEMPLATE_SHEET_ID}"
    # fi
    # Note: Only change directories when we actually entered ./github-tools/

    # Commit and Push Changelog Changes (exclude commits.csv)
    echo "Adding and committing changes.."
    local commit_msg="update changelog for ${new_version}"
    if [[ "${previous_version_ref,,}" == "null" ]]; then
      commit_msg="${commit_msg} (hotfix - no test plan)"
    fi
    if ! (git commit -am "${commit_msg}"); then
      echo "No changes detected; skipping commit."
    fi

    local pr_body="This PR updates the change log for ${new_version}."
    if [[ "${previous_version_ref,,}" == "null" ]]; then
      pr_body="${pr_body} (Hotfix - no test plan generated.)"
    fi

    # Use helper functions for push and PR creation
    push_branch_with_handling "${changelog_branch_name}"
    create_pr_if_not_exists "${changelog_branch_name}" "release: ${changelog_branch_name}" "${pr_body}" "${release_branch_name}" "" "search"

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

    # Ensure base branch exists locally; fetch from origin if missing
    if ! git rev-parse --verify --quiet "refs/heads/${main_branch}" >/dev/null; then
        echo "Base branch ${main_branch} not found locally. Attempting to fetch from origin..."
        if git ls-remote --heads origin "${main_branch}" | grep -q "."; then
            git fetch origin "${main_branch}:${main_branch}" || git fetch origin "${main_branch}"
            echo "Fetched base branch ${main_branch} from origin."
        else
            echo "Error: Base branch not found on origin: ${main_branch}"
            exit 1
        fi
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
    release_branch_name=$(get_release_branch_name "$NEW_VERSION")
    changelog_branch_name="release/${NEW_VERSION}-Changelog"
    version_bump_branch_name=$(get_version_bump_branch_name "$next_version")    # Execute main workflow
    configure_git

    # Step 1: Create release branch and PR
    create_release_pr "$PLATFORM" "$NEW_VERSION" "$NEW_VERSION_NUMBER" "$release_branch_name" "$changelog_branch_name"

    # Step 2: Create changelog PR (in test mode, skips auto-changelog but still generates commits.csv)
    create_changelog_pr "$PLATFORM" "$NEW_VERSION" "$PREVIOUS_VERSION_REF" "$release_branch_name" "$changelog_branch_name"

    # Step 3: Create version bump PR for main branch (skip for hotfix releases)
    if [[ "${PREVIOUS_VERSION_REF,,}" == "null" ]]; then
        echo "Skipping version bump PR for hotfix release (previous-version-ref is 'null')."
    else
        create_version_bump_pr "$PLATFORM" "$NEW_VERSION" "$next_version" "$version_bump_branch_name" "$release_branch_name" "main"
    fi

    # Final summary
    echo ""
    echo "========================================="
    echo "Release automation complete!"
    echo "========================================="
    echo "Created PRs:"
    echo "1. Release PR: release: ${NEW_VERSION}"
    if [ "$TEST_ONLY" == "true" ]; then
        echo "2. Changelog PR: release: ${changelog_branch_name} (test mode - auto-changelog skipped, commits.csv generated)"
    else
        echo "2. Changelog PR: release: ${changelog_branch_name}"
    fi
    if [[ "${PREVIOUS_VERSION_REF,,}" == "null" ]]; then
        echo "(Hotfix) Skipped version bump PR"
    else
        echo "3. Version bump PR: Bump main version to ${next_version}"
    fi
    echo "========================================="
}

# Execute main function only if script is run directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
