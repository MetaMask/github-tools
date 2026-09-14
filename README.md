# GitHub Tools

A place for internal GitHub tools to exist and be used.

## Usage

This repository holds a collection of scripts which are intended to be run locally:

- `yarn get-review-metrics`: Gets the PR load of the extension platform team.
- `yarn count-references-to-contributor-docs`: Counts the number of references to the `contributor-docs` repo in pull request comments.

- `yarn run slack:release-testing`: Publishes a notification to slack for active releases regarding the release testing statuses.

- `yarn segment-schema:draft-pr`: Generates Segment schema YAML from a Mobile or Extension analytics diff (see [Draft Segment schema PR](#draft-segment-schema-pr)).

### Authentication

Some scripts require a GitHub token in order to run fully.

For best results, create a [classic personal token](https://github.com/settings/tokens) and ensure that it has the following scopes:

- `read:org`
- `public_repo`

To use the token, you need to set the `GITHUB_AUTH_TOKEN` environment variable:

```
GITHUB_AUTH_TOKEN="<your GitHub token>" <command>
```

It's recommended to use your machine's local keychain to store the token and retrieve it from there. For example, under macOS, you can use the following command to store the token:

```
security add-generic-password -a $USER -s 'GitHub auth token' -w "<your GitHub token>"
```

Now you can use the token like this:

```
GITHUB_NPM_TOKEN="$(security find-generic-password a $USER -s 'GitHub auth token' -w)" <command>
```

### Logging

Some scripts print additional information that may be useful for debugging. To see it, set the `DEBUG` environment variable as follows:

```
DEBUG="metamask:*" <command>
```

## Contributing

### Setup

- Install [Node.js](https://nodejs.org) version 20
  - If you are using [nvm](https://github.com/creationix/nvm#installation) (recommended) running `nvm use` will automatically choose the right node version for you.
- Install [Yarn v3](https://yarnpkg.com/getting-started/install)
- Run `yarn install` to install dependencies and run any required post-install scripts

### Testing and Linting

Run `yarn test` to run the tests once. To run tests on file changes, run `yarn test:watch`.

Run `yarn lint` to run the linter, or run `yarn lint:fix` to run the linter and fix any automatically fixable issues.

## Draft Segment schema PR

Composite action: `.github/actions/draft-segment-schema-pr`. It is a helper, not a merge gate. One Mobile or Extension pull request maps to one draft PR on `Consensys/segment-schema`.

**Opt-in phrase** (first line of the PR author's comment, exact match, optional trailing whitespace):

```
I agree to open a draft Segment schema PR
```

### Modes

A `github-script` gate runs before github-tools is installed. Forks, opt-out labels, comments that are not the agreement sentence, `close` when no schema PR exists, and PRs with no analytics-looking file list (and no sticky proposal to edit) end the job there.

Pull requests that change more than 150 non-test TypeScript files skip YAML generation. The sticky comment says so; the author opens the schema PR manually.

| Mode      | Event                                                             | What it does                                                                                                                                                               |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose` | `pull_request` opened / synchronize / reopened / ready_for_review | After the gate, generate YAML and post or edit one proposal comment. Git-push only if an **open** schema PR already exists.                                                |
| `create`  | `issue_comment` created                                           | First git-push and `pulls.create` (`draft: true`) when the commenter is the PR author, the client PR is still open, it is not a fork, and there are additive YAML changes. |
| `close`   | `pull_request` closed                                             | If a schema PR exists and the client PR was **not** merged, close the schema PR. If merged, leave it open.                                                                 |

Forks: `propose` / `close` skip when `head.repo.full_name != github.repository`. `create` matches Mobile/Extension `update-attributions.yml`: a first job runs `gh pr view -R` `--json isCrossRepository` and mints the GitHub App token only when that is `false`.

Auth: jobs use `environment: segment-schema` and `actions/create-github-app-token@v3` (no `owner` / `repositories`). Pass `steps.app-token.outputs.token` as `segment-schema-token`. Every schema write names `Consensys/segment-schema` explicitly.

### Local CLI

From this repo, generate needs `GITHUB_TOKEN` (writes YAML into `--schema`; use a throwaway copy of `segment-schema`):

```
GITHUB_TOKEN=ghp_xxx yarn segment-schema:draft-pr \
  --phase generate \
  --mode propose \
  --platform mobile \
  --schema /path/to/segment-schema-copy \
  --client-repository MetaMask/metamask-mobile \
  --pr-number 12 \
  --base-sha <pr-base-sha> \
  --head-sha <pr-head-sha>
```

`--phase publish --dry-run` prints the summary path and skips GitHub writes.

### Consumer workflow contract

Land this in `metamask-mobile` and `metamask-extension` **after** this action ships. Pin a github-tools commit SHA until `@v1` exists. The workflow must not be a required status check. `issue_comment` workflows must live on the default branch. The `segment-schema` environment must have no required reviewers or wait timer.

`paths-ignore` skips the workflow only when **every** changed file matches. Draft PRs and bot-authored PRs skip `propose`. Two concurrency groups keep a `propose` from cancelling a `create` between `git push` and `pulls.create`.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, closed]
    paths-ignore:
      - '**/*.md'
      - 'docs/**'
      - 'locales/**'
      - '**/*.test.*'
      - '**/*.spec.*'
      - '**/__snapshots__/**'
      - 'e2e/**'
      - 'ios/**'
      - 'android/**'
      - '**/*.json'
      - '**/*.png'
      - '**/*.svg'
      - '.github/**'
  issue_comment:
    types: [created]
jobs:
  propose:
    if: >
      github.event_name == 'pull_request' &&
      github.event.action != 'closed' &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.user.type != 'Bot' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      !contains(github.event.pull_request.labels.*.name, 'no-schema-pr')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: segment-schema
    concurrency:
      group: draft-segment-schema-propose-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: MetaMask/github-tools/.github/actions/draft-segment-schema-pr@<pin-sha-then-v1>
        with:
          platform: mobile
          mode: propose
          segment-schema-token: ${{ steps.app-token.outputs.token }}
          segment-schema-repository: Consensys/segment-schema
  is-cross-repo-pr:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      github.event.comment.user.login == github.event.issue.user.login &&
      startsWith(github.event.comment.body, 'I agree to open a draft Segment schema PR')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      IS_CROSS_REPO_PR: ${{ steps.is-cross-repo.outputs.IS_CROSS_REPO_PR }}
    steps:
      - id: is-cross-repo
        run: echo "IS_CROSS_REPO_PR=$(gh pr view -R "$GITHUB_REPOSITORY" --json isCrossRepository --jq '.isCrossRepository' "${PR_NUMBER}")" >> "$GITHUB_OUTPUT"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.issue.number }}
  create:
    needs: is-cross-repo-pr
    if: ${{ needs.is-cross-repo-pr.outputs.IS_CROSS_REPO_PR == 'false' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: segment-schema
    concurrency:
      group: draft-segment-schema-write-${{ github.event.issue.number }}
      cancel-in-progress: false
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: MetaMask/github-tools/.github/actions/draft-segment-schema-pr@<pin-sha-then-v1>
        with:
          platform: mobile
          mode: create
          segment-schema-token: ${{ steps.app-token.outputs.token }}
          segment-schema-repository: Consensys/segment-schema
  close-segment-schema-pr:
    if: >
      github.event_name == 'pull_request' &&
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: segment-schema
    concurrency:
      group: draft-segment-schema-write-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: MetaMask/github-tools/.github/actions/draft-segment-schema-pr@<pin-sha-then-v1>
        with:
          platform: mobile
          mode: close
          segment-schema-token: ${{ steps.app-token.outputs.token }}
          segment-schema-repository: Consensys/segment-schema
```

Use `platform: extension` in the Extension repo. Do not land these workflows until a pin-able github-tools SHA exists.
