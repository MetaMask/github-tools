# GitHub Tools

A place for internal GitHub tools to exist and be used.

## Usage

This repository holds a collection of scripts which are intended to be run locally:

- `yarn get-review-metrics`: Gets the PR load of the extension platform team.
- `yarn count-references-to-contributor-docs`: Counts the number of references to the `contributor-docs` repo in pull request comments.

- `yarn run slack:release-testing`: Publishes a notification to slack for active releases regarding the release testing statuses.

- `yarn segment-schema:draft-pr`: Local CLI for the Segment schema draft. See the [CLI](src/segment-schema-draft-pr/README.md) and the [action](.github/actions/draft-segment-schema-pr/README.md).

### Dependabot PR reminder

The reusable workflow `.github/workflows/remind-dependabot-prs.yml` posts a Slack thread listing open Dependabot PRs, grouped by owning team. Team Slack tags come from `topology.json` in `MetaMask/MetaMask-planning`. Nothing is posted if no Dependabot PRs are open. Draft PRs are skipped. PRs with failing CI and PRs that are approved with no owning team left are listed under the fallback team. Owners are identified only by team review requests: if the org auto-assigns individual reviewers (not teams) via code owners or team settings, those PRs are reported under the fallback team as needing an owner.

| Input               | Required | Default         | Description                                                                                 |
| ------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------- |
| `owner-teams`       | No       |                 | Comma-separated team slugs that own the repo. If unset, all requested-reviewer teams count. |
| `fallback-team`     | No       | `core-platform` | Team that gets PRs with no owning team, failing CI, or approved with no owning team left.   |
| `topology-ref`      | No       | `main`          | Ref of `MetaMask/MetaMask-planning` to read `topology.json` from.                           |
| `slack-webhook-url` | Yes      |                 | Secret. Each repo passes its own so it can post to its own channel.                         |

Requirements for the calling repo:

- The caller workflow must be named `remind-dependabot-prs.yml` (the token-exchange-service policy matches on the caller's workflow file name).
- The job permissions must include `contents: read`, `pull-requests: read`, `checks: read`, `statuses: read` and `id-token: write`.
- A `default-branch` environment must exist and allow the branch the cron runs on (`main`).
- The repository variable `TOKEN_EXCHANGE_URL` must be set.
- A token-exchange-service policy must let the caller read `MetaMask/MetaMask-planning` with `contents: read`.

`@v1` resolves only after a release of this repository. Pointing a caller at a branch ref is not enough for a pre-release smoke test, because the reusable workflow also references `MetaMask/github-tools/.github/actions/remind-dependabot-prs@v1` and `get-token@v1` internally; temporarily edit those inner `uses:` refs to the branch ref.

Polyrepo (for example `metamask-extension`):

```yaml
name: Remind Dependabot PRs

on:
  schedule:
    - cron: '0 14 * * 1'
  workflow_dispatch:

jobs:
  remind:
    permissions:
      contents: read
      pull-requests: read
      checks: read
      statuses: read
      id-token: write
    uses: MetaMask/github-tools/.github/workflows/remind-dependabot-prs.yml@v1
    with:
      owner-teams: extension-platform
      fallback-team: extension-platform
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Monorepo (for example `core`), with no extra inputs:

```yaml
name: Remind Dependabot PRs

on:
  schedule:
    - cron: '0 14 * * 1'
  workflow_dispatch:

jobs:
  remind:
    permissions:
      contents: read
      pull-requests: read
      checks: read
      statuses: read
      id-token: write
    uses: MetaMask/github-tools/.github/workflows/remind-dependabot-prs.yml@v1
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

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
