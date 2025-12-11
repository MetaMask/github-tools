#!/bin/bash
# =============================================================================
# Release Branch Sync Script
# =============================================================================
# Purpose: After a release branch is merged into stable, create PRs to sync
#          stable into all active release branches.
#
# Flow:
#   1. Find release branches with active release PRs (open/draft PRs titled "release: X.Y.Z")
#   2. For each one, create a branch from stable (stable-sync-release-X.Y.Z)
#   3. Create a PR from that branch into the release branch
#   4. Conflicts are left for manual resolution by developers
#
# Note: Only release branches with an active release PR are synced. This ensures
#       we don't create unnecessary sync PRs for abandoned or completed releases.
#
# Environment variables:
#   MERGED_RELEASE_BRANCH - The release branch that was just merged (e.g., release/7.35.0)
#   REPO_TYPE             - Repository type: 'mobile' or 'extension'
#   GITHUB_TOKEN          - GitHub token for authentication and PR creation
# =============================================================================

set -e

# Regex pattern for valid release branch names (release/X.Y.Z)
RELEASE_BRANCH_PATTERN='^release/[0-9]+\.[0-9]+\.[0-9]+$'

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

log_info() {
  echo "INFO: $1"
}

log_success() {
  echo "SUCCESS: $1"
}

log_warning() {
  echo "WARNING: $1"
}

log_error() {
  echo "ERROR: $1"
}

log_section() {
  echo ""
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

# Validate that a branch name matches the release/X.Y.Z format
is_valid_release_branch() {
  local branch=$1
  [[ "$branch" =~ $RELEASE_BRANCH_PATTERN ]]
}

# Check if a sync PR already exists for a release branch
pr_exists() {
  local release_branch=$1
  local sync_branch=$2
  
  local existing_pr
  # Use fallback to "0" if gh command fails (network/auth issues)
  # This is safe because gh pr create will also fail if there's a real issue,
  # and GitHub rejects duplicate PRs anyway
  existing_pr=$(gh pr list --base "$release_branch" --head "$sync_branch" --state open --json number --jq 'length' 2>/dev/null || echo "0")
  
  [[ "$existing_pr" -gt 0 ]]
}

# Parse version from release branch name (release/X.Y.Z -> X.Y.Z)
parse_version() {
  local branch=$1
  echo "$branch" | sed 's|release/||'
}

# Compare two semantic versions
# Returns: 0 if v1 < v2, 1 if v1 >= v2
is_version_older() {
  local v1=$1
  local v2=$2
  
  local oldest
  oldest=$(printf '%s\n%s\n' "$v1" "$v2" | sort -V | head -n1)
  
  [[ "$v1" == "$oldest" && "$v1" != "$v2" ]]
}

# Check if stable has commits that the release branch doesn't have
stable_has_new_commits() {
  local release_branch=$1
  
  # Count commits in stable that are not in the release branch
  local ahead_count
  ahead_count=$(git rev-list --count "origin/${release_branch}..origin/stable" 2>/dev/null || echo "0")
  
  [[ "$ahead_count" -gt 0 ]]
}

# Find release branches that have active release PRs (open or draft)
# Active release PRs have titles matching "release: X.Y.Z" pattern
# Returns: newline-separated list of release branch names (e.g., release/7.36.0)
get_active_release_branches() {
  local branches=""
  
  # Query open and draft PRs with title starting with "release:" (case-insensitive)
  # The jq filter extracts version from PR titles like "release: 7.36.0" or "Release: 7.36.0 (#1234)"
  local pr_data
  pr_data=$(gh pr list \
    --state open \
    --json title,isDraft \
    --jq '.[] | select(.title | test("^release:\\s*[0-9]+\\.[0-9]+\\.[0-9]+"; "i")) | .title' \
    2>/dev/null || echo "")
  
  if [[ -z "$pr_data" ]]; then
    echo ""
    return
  fi
  
  # Extract version numbers from PR titles and convert to branch names
  while IFS= read -r title; do
    if [[ -n "$title" ]]; then
      # Extract version (X.Y.Z) from title like "release: 7.36.0" or "Release: 7.36.0 (#1234)"
      local version
      version=$(echo "$title" | sed -E 's/^[Rr]elease:\s*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
      if [[ -n "$version" ]]; then
        local branch="release/${version}"
        # Only add if not already in list
        if [[ ! "$branches" =~ $branch ]]; then
          if [[ -n "$branches" ]]; then
            branches="${branches}"$'\n'"${branch}"
          else
            branches="$branch"
          fi
        fi
      fi
    fi
  done <<< "$pr_data"
  
  # Sort by version
  echo "$branches" | sort -t'/' -k2 -V
}

# Create a sync PR for a release branch
create_sync_pr() {
  local release_branch=$1
  local sync_branch=$2
  
  local body="## Summary

This PR syncs the latest changes from \`stable\` into \`${release_branch}\`.

## Why is this needed?

A release branch (\`${MERGED_RELEASE_BRANCH}\`) was merged into \`stable\`. This PR brings those changes (hotfixes, etc.) into \`${release_branch}\`.

## Action Required

**Please review and resolve any merge conflicts manually.**

If there are conflicts, they will appear in this PR. Resolve them to ensure the release branch has all the latest fixes from stable."

  gh pr create \
    --base "$release_branch" \
    --head "$sync_branch" \
    --title "chore: sync stable into ${release_branch}" \
    --body "$body"
}

# Process a single release branch
# Returns: 0 = PR created, 1 = failed, 2 = skipped
process_release_branch() {
  local release_branch=$1
  local merged_version=$2
  local release_version
  release_version=$(parse_version "$release_branch")
  
  log_section "Processing ${release_branch}"
  
  # Skip branches that don't match the release/X.Y.Z format
  if ! is_valid_release_branch "$release_branch"; then
    log_info "Skipping ${release_branch} (does not match release/X.Y.Z format)"
    return 2
  fi
  
  # Skip the branch that was just merged
  if [[ "$release_branch" == "$MERGED_RELEASE_BRANCH" ]]; then
    log_info "Skipping ${release_branch} (just merged into stable)"
    return 2
  fi
  
  # Skip branches older than the merged release
  if is_version_older "$release_version" "$merged_version"; then
    log_info "Skipping ${release_branch} (older than merged release ${MERGED_RELEASE_BRANCH})"
    return 2
  fi
  
  # Verify the branch exists on the remote
  if ! git ls-remote --heads origin "$release_branch" | grep -q "$release_branch"; then
    log_warning "Skipping ${release_branch} (branch does not exist on remote)"
    return 2
  fi
  
  # Create sync branch name (replace / with -)
  local sync_branch="stable-sync-${release_branch//\//-}"
  
  # Check if a sync PR already exists
  if pr_exists "$release_branch" "$sync_branch"; then
    log_warning "Sync PR already exists for ${release_branch}, skipping"
    return 2
  fi
  
  # Check if stable has any new commits compared to the release branch
  if ! stable_has_new_commits "$release_branch"; then
    log_success "${release_branch} is already up-to-date with stable, no sync needed"
    return 2
  fi
  
  log_info "Creating sync branch: ${sync_branch} (from stable)"
  
  # Ensure we're on a clean state
  git checkout -f origin/stable 2>/dev/null || true
  git clean -fd
  
  # Delete local sync branch if it exists
  git branch -D "$sync_branch" 2>/dev/null || true
  
  # Create sync branch from stable
  git checkout -b "$sync_branch" origin/stable
  
  # Push the sync branch (force in case it exists remotely)
  log_info "Pushing ${sync_branch}..."
  if git push -u origin "$sync_branch" --force; then
    log_success "Pushed ${sync_branch}"
  else
    log_error "Failed to push ${sync_branch}"
    return 1
  fi
  
  # Create the PR (stable-sync branch → release branch)
  log_info "Creating PR: ${sync_branch} → ${release_branch}"
  if create_sync_pr "$release_branch" "$sync_branch"; then
    log_success "Created PR for ${release_branch}"
  else
    log_error "Failed to create PR for ${release_branch}"
    return 1
  fi
  
  return 0
}

# -----------------------------------------------------------------------------
# Main Script
# -----------------------------------------------------------------------------

main() {
  log_section "Release Branch Sync"
  
  # Validate environment
  if [[ -z "$MERGED_RELEASE_BRANCH" ]]; then
    log_error "MERGED_RELEASE_BRANCH environment variable is required"
    exit 1
  fi
  
  # Validate branch format (defense in depth - workflow also validates this)
  if ! is_valid_release_branch "$MERGED_RELEASE_BRANCH"; then
    log_error "MERGED_RELEASE_BRANCH '${MERGED_RELEASE_BRANCH}' does not match release/X.Y.Z format"
    exit 1
  fi
  
  if [[ -z "$GITHUB_TOKEN" ]]; then
    log_error "GITHUB_TOKEN environment variable is required"
    exit 1
  fi
  
  log_info "Merged release branch: ${MERGED_RELEASE_BRANCH}"
  log_info "Repository type: ${REPO_TYPE:-not set}"
  
  # Get version of the merged release
  local merged_version
  merged_version=$(parse_version "$MERGED_RELEASE_BRANCH")
  log_info "Merged version: ${merged_version}"
  
  # Fetch all branches
  log_info "Fetching all branches..."
  git fetch --all --prune
  
  # Find release branches with active release PRs
  log_info "Finding release branches with active release PRs (open/draft PRs titled 'release: X.Y.Z')..."
  local release_branches
  release_branches=$(get_active_release_branches)
  
  if [[ -z "$release_branches" ]]; then
    log_warning "No active release branches found (no open/draft PRs with 'release: X.Y.Z' title)"
    exit 0
  fi
  
  log_info "Found active release branches:"
  echo "$release_branches" | while read -r branch; do
    echo "  - $branch"
  done
  
  # Process each release branch
  local processed=0
  local skipped=0
  local failed=0
  
  while IFS= read -r branch; do
    if [[ -z "$branch" ]]; then
      continue
    fi
    
    local result
    process_release_branch "$branch" "$merged_version" && result=$? || result=$?
    
    case $result in
      0) ((processed++)) || true ;;  # PR created
      1) ((failed++)) || true ;;     # Failed
      2) ((skipped++)) || true ;;    # Skipped
    esac
  done <<< "$release_branches"
  
  # Summary
  log_section "Summary"
  log_info "PRs created: ${processed}"
  log_info "Skipped: ${skipped}"
  if [[ "$failed" -gt 0 ]]; then
    log_error "Failed: ${failed}"
    exit 1
  fi
  
  log_success "Release branch sync completed!"
}

main "$@"
