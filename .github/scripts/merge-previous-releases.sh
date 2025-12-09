#!/bin/bash

# Merge Previous Release Branches Script
#
# This script is triggered when a new release branch is created (e.g., release/2.1.2).
# It finds all previous release branches and merges them into the new release branch.
#
# Key behaviors:
# - Merges ALL older release branches into the new one
# - For merge conflicts, favors the destination branch (new release)
# - Both branches remain open after merge
# - Fails fast on errors to prevent pushing partial merges
#
# Environment variables:
# - NEW_RELEASE_BRANCH: The newly created release branch (e.g., release/2.1.2)

set -e

# Parse a release branch name to extract version components
# Returns: "major minor patch" or empty string if not valid
parse_release_version() {
  local branch_name="$1"
  if [[ "$branch_name" =~ ^release/([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
  fi
}

# Check if version A is older than version B
# Returns: exit code 0 if a < b, 1 otherwise
is_version_older() {
  local a_major="$1" a_minor="$2" a_patch="$3"
  local b_major="$4" b_minor="$5" b_patch="$6"

  if [[ "$a_major" -lt "$b_major" ]]; then return 0; fi
  if [[ "$a_major" -gt "$b_major" ]]; then return 1; fi
  if [[ "$a_minor" -lt "$b_minor" ]]; then return 0; fi
  if [[ "$a_minor" -gt "$b_minor" ]]; then return 1; fi
  if [[ "$a_patch" -lt "$b_patch" ]]; then return 0; fi
  return 1
}

# Execute a git command and log it
git_exec() {
  echo "Executing: git $*"
  git "$@"
}

# Check if a branch has already been merged into the current branch. If yes, we skip merging it again.
# Returns: exit code 0 if merged, 1 if not merged
is_branch_merged() {
  local source_branch="$1"
  git merge-base --is-ancestor "origin/${source_branch}" HEAD 2>/dev/null
}

# Merge a source branch (older release branch) into the current branch (new release branch), favoring current branch on conflicts
merge_with_favor_destination() {
  local source_branch="$1"
  local dest_branch="$2"

  echo ""
  echo "============================================================"
  echo "Merging ${source_branch} into ${dest_branch}"
  echo "============================================================"

  # Check if already merged
  if is_branch_merged "$source_branch"; then
    echo "Branch ${source_branch} is already merged into ${dest_branch}. Skipping."
    return 1  # Return 1 to indicate skipped
  fi

  # Try to merge with "ours" strategy for conflicts (favors current branch (new release))
  if git_exec merge "origin/${source_branch}" -X ours --no-edit -m "Merge ${source_branch} into ${dest_branch}"; then
    echo "✅ Successfully merged ${source_branch} into ${dest_branch}"
    return 0  # Return 0 to indicate merged
  fi

  # If merge still fails (shouldn't happen with -X ours, but just in case)
  echo "⚠️  Merge conflict detected! Resolving by favoring destination branch (new release)..."

  # First, resolve any unmerged (conflicted) files by keeping our version
  local conflict_files
  local conflict_count=0
  conflict_files=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [[ -n "$conflict_files" ]]; then
    while IFS= read -r file; do
      if [[ -n "$file" ]]; then
        echo "  - Conflict in: ${file} → keeping destination version"
        git_exec checkout --ours "$file"
        git_exec add "$file"
        ((conflict_count++)) || true
      fi
    done <<< "$conflict_files"
    echo "✅ Resolved ${conflict_count} conflict(s) by keeping destination branch version"
  fi

  # Now add any remaining files (non-conflicted changes), excluding github-tools directory
  git_exec add -- . ':!github-tools'

  # Unstage .gitignore to avoid committing workflow-specific changes (github-tools/ entry)
  # Using reset instead of checkout because .gitignore may not exist in HEAD
  git reset HEAD -- .gitignore 2>/dev/null || true

  # Complete the merge - always commit when in merge state, even if no content changes
  # Check if we're in a merge state (MERGE_HEAD exists)
  if [[ -f .git/MERGE_HEAD ]]; then
    if ! git_exec commit -m "Merge ${source_branch} into ${dest_branch}" --no-verify --allow-empty; then
      echo "Failed to commit merge of ${source_branch}"
      exit 1
    fi
  fi

  echo "✅ Successfully merged ${source_branch} into ${dest_branch} (${conflict_count} conflict(s) resolved)"
  return 0  # Return 0 to indicate merged
}

main() {
  if [[ -z "$NEW_RELEASE_BRANCH" ]]; then
    echo "Error: NEW_RELEASE_BRANCH environment variable is not set"
    exit 1
  fi

  echo "New release branch: ${NEW_RELEASE_BRANCH}"

  # Parse the new release version
  local new_version
  new_version=$(parse_release_version "$NEW_RELEASE_BRANCH")
  if [[ -z "$new_version" ]]; then
    echo "Error: ${NEW_RELEASE_BRANCH} is not a valid release branch (expected format: release/X.Y.Z)"
    exit 1
  fi

  read -r new_major new_minor new_patch <<< "$new_version"
  echo "Parsed version: ${new_major}.${new_minor}.${new_patch}"

  # Fetch all remote branches
  git_exec fetch origin

  # Get all release branches
  local all_release_branches=()
  while IFS= read -r branch; do
    # Remove "origin/" prefix and whitespace
    branch="${branch#*origin/}"
    branch="${branch// /}"
    if [[ -n "$branch" ]] && [[ -n "$(parse_release_version "$branch")" ]]; then
      all_release_branches+=("$branch")
    fi
  done < <(git branch -r --list "origin/release/*")

  echo ""
  echo "Found ${#all_release_branches[@]} release branches:"
  for b in "${all_release_branches[@]}"; do
    echo "  - $b"
  done

  # Filter to only branches older than the new one
  local older_branches=()
  for branch in "${all_release_branches[@]}"; do
    local version
    version=$(parse_release_version "$branch")
    if [[ -n "$version" ]]; then
      read -r major minor patch <<< "$version"
      if is_version_older "$major" "$minor" "$patch" "$new_major" "$new_minor" "$new_patch"; then
        older_branches+=("$branch")
      fi
    fi
  done

  # Sort older branches from oldest to newest using version sort
  local sorted_branches=()
  while IFS= read -r branch; do
    [[ -n "$branch" ]] && sorted_branches+=("$branch")
  done < <(printf '%s\n' "${older_branches[@]}" | sort -V)
  older_branches=("${sorted_branches[@]}")

  if [[ ${#older_branches[@]} -eq 0 ]]; then
    echo ""
    echo "No older release branches found. Nothing to merge."
    exit 0
  fi

  echo ""
  echo "Older release branches found (oldest to newest):"
  for b in "${older_branches[@]}"; do
    echo "  - $b"
  done

  echo ""
  echo "Will merge all ${#older_branches[@]} older branches."

  # Verify we're on the right branch
  local current_branch
  current_branch=$(git branch --show-current)
  if [[ "$current_branch" != "$NEW_RELEASE_BRANCH" ]]; then
    echo "Switching to ${NEW_RELEASE_BRANCH}..."
    git_exec checkout "$NEW_RELEASE_BRANCH"
  fi

  # Merge each branch (fail fast on errors)
  local merged_count=0
  local skipped_count=0

  for older_branch in "${older_branches[@]}"; do
    if merge_with_favor_destination "$older_branch" "$NEW_RELEASE_BRANCH"; then
      ((merged_count++)) || true
    else
      ((skipped_count++)) || true
    fi
  done

  # Only push if we actually merged something
  if [[ "$merged_count" -gt 0 ]]; then
    echo ""
    echo "Pushing merged changes..."
    git_exec push origin "$NEW_RELEASE_BRANCH"
  else
    echo ""
    echo "No new merges were made (all branches were already merged)."
  fi

  echo ""
  echo "============================================================"
  echo "Merge complete!"
  echo "  Branches merged: ${merged_count}"
  echo "  Branches skipped (already merged): ${skipped_count}"
  echo "All source branches remain open as requested."
  echo "============================================================"
}

# Run main and handle errors
main "$@"
