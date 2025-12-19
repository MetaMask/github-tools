#!/usr/bin/env bash

# Shared utility functions for release scripts

configure_git() {
    local name="${1:-${GIT_AUTHOR_NAME:-metamaskbot}}"
    local email="${2:-${GIT_AUTHOR_EMAIL:-metamaskbot@users.noreply.github.com}}"
    
    echo "Configuring git.."
    git config user.name "${name}"
    git config user.email "${email}"

    echo "Fetching from remote..."
    git fetch
}

checkout_or_create_branch() {
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

