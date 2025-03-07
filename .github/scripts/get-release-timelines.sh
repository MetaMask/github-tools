#!/usr/bin/env bash

if [[ -z "${OWNER}" ]]; then
  echo "::error::Owner not provided. Set the 'OWNER' environment variable."
  exit 1
fi

if [[ -z "${REPOSITORY}" ]]; then
  echo "::error::Repository not provided. Set the 'REPOSITORY' environment variable."
  exit 1
fi

if [[ -z "${VERSION}" ]]; then
  echo "::error::Version not provided. Set the 'VERSION' environment variable."
  exit 1
fi

if [[ -z "${RUNWAY_APP_ID}" ]]; then
  echo "::error::RUNWAY_APP_ID not provided. Set the 'RUNWAY_APP_ID' environment variable."
  exit 1
fi

if [[ -z "${RUNWAY_API_KEY}" ]]; then
  echo "::error::RUNWAY_API_KEY not provided. Set the 'RUNWAY_API_KEY' environment variable."
  exit 1
fi

release_timelines_filename="release-timelines-${VERSION}.csv"

echo "release_pr_merged_at,release_submitted_at,rollout_1_at,rollout_10_at,rollout_100_at,issue_created_at,last_team_assigned_at,triage_completed_at,bugfix_pr_created_at,bugfix_pr_merged_at,cherry_pick_pr_created_at,cherry_pick_pr_merged_at" > "${release_timelines_filename}"

release_branch="Version-v${VERSION}"
release_pr_title="Version v${VERSION}"

release_pr=$(gh pr list --repo "${OWNER}/${REPOSITORY}" --head "${release_branch}" --base master --state merged --json title,mergedAt | jq --arg title "${release_pr_title}" '.[] | select(.title == $title)')
release_pr_merged_at=$(echo "${release_pr}" | jq -r '.mergedAt')

if [[ -z "${release_pr_merged_at}" || "${release_pr_merged_at}" == "null" ]]; then
  echo "::error::Release PR with title '${release_pr_title}' not found"
  exit 1
fi

rollout_1_at="null"
rollout_10_at="null"
rollout_100_at="null"

runway_release_id="${RUNWAY_APP_ID}:${VERSION}"
release_submitted_at=$(curl --silent --header "X-API-Key: ${RUNWAY_API_KEY}" "https://api.runway.team/v1/app/${RUNWAY_APP_ID}/release/${runway_release_id}" | jq -r '.submittedAt')

release_label="regression-RC-${VERSION}"
release_blockers=$(gh issue list --repo "${OWNER}/${REPOSITORY}" --state all --label "release-blocker,${release_label}" --limit 100 --json number,createdAt)
rollout_blockers=$(gh issue list --repo "${OWNER}/${REPOSITORY}" --state all --label "rollout-blocker,${release_label}" --limit 100 --json number,createdAt)
all_blockers=$(jq -s 'add' <<< "${release_blockers} ${rollout_blockers}")

echo "${all_blockers}" | jq -c '.[]' | while IFS= read -r issue; do
  issue_created_at=$(echo "${issue}" | jq -r '.createdAt')
  issue_number=$(echo "${issue}" | jq -r '.number')

  timeline=$(gh api --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28" "/repos/${OWNER}/${REPOSITORY}/issues/${issue_number}/timeline")
  last_team_assigned_at=$(echo "${timeline}" | jq -r '[.[] | select(.event == "labeled" and (.label.name | startswith("team-")))] | last.created_at')
  triage_completed_at=$(echo "${timeline}" | jq -r '[.[] | select(.event == "unlabeled" and (.label.name == "needs-triage"))] | last.created_at')

  # shellcheck disable=SC2016
  linked_prs=$(gh api graphql -F owner="${OWNER}" -F name="${REPOSITORY}" -F number="${issue_number}" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
            nodes {
              title
              createdAt
              mergedAt
            }
          }
        }
      }
    }' | jq -r '.data.repository.issue.closedByPullRequestsReferences.nodes')

  bugfix_pr=$(echo "${linked_prs}" | jq -r '[.[] | select(.title | contains("cherry-pick") | not)] | last')
  bugfix_pr_created_at=$(echo "${bugfix_pr}" | jq -r '.createdAt')
  bugfix_pr_merged_at=$(echo "${bugfix_pr}" | jq -r '.mergedAt')

  cherry_pick_pr=$(echo "${linked_prs}" | jq -r '[.[] | select(.title | contains("cherry-pick"))] | last')
  cherry_pick_pr_created_at=$(echo "${cherry_pick_pr}" | jq -r '.createdAt')
  cherry_pick_pr_merged_at=$(echo "${cherry_pick_pr}" | jq -r '.mergedAt')

  echo "${release_pr_merged_at},${release_submitted_at},${rollout_1_at},${rollout_10_at},${rollout_100_at},${issue_created_at},${last_team_assigned_at},${triage_completed_at},${bugfix_pr_created_at},${bugfix_pr_merged_at},${cherry_pick_pr_created_at},${cherry_pick_pr_merged_at}" >> "${release_timelines_filename}"
done
