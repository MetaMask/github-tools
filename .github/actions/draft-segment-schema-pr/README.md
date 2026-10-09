# Draft Segment schema PR

Composite action that detects analytics event and property changes on a Mobile or Extension pull request, posts one proposal comment, and opens one draft pull request on `Consensys/segment-schema` after the author agrees.

One client pull request maps to branch `metamaskbot/<platform>-pr-<N>`. The action is a helper.

The [CLI](../../../src/segment-schema-draft-pr/README.md) is what this action runs for generate and publish. Inputs live in `action.yml`.

## Modes

| Mode | Event | What it does |
| --- | --- | --- |
| `propose` | `pull_request` opened, synchronize, reopened, ready_for_review | Generates YAML and posts or edits one proposal comment. Pushes the bot branch when an open schema pull request already exists. |
| `create` | `issue_comment` created | Pushes the bot branch and opens a draft schema pull request when the commenter is the pull request author, the client pull request is open, the head is in the same repository, and generate produced additive YAML. |
| `close` | `pull_request` closed | When a schema pull request exists and the client pull request is unmerged, comments on the schema pull request and closes it. A merged client pull request leaves the schema draft open. Close leaves the bot branch in place. |

The agreement sentence is the first line of the author's comment, with optional trailing whitespace:

```
I agree to open a draft Segment schema PR
```

The label `no-schema-pr` opts that pull request out.

## Gate

A `github-script` step runs before github-tools is installed. It ends the job for a fork head, the opt-out label, a comment that is not the agreement sentence, `close` when no schema pull request exists, and a file list with no analytics signal and no sticky proposal to edit.

`propose` runs when the event is `pull_request`, the action is not `closed`, the pull request is ready for review, the author is not a Bot, the head repository is this repository, and the opt-out label is absent.

A pull request that changes more than 150 non-test TypeScript files skips YAML generation. The sticky comment tells the author to open the schema pull request. A rename counts as one file.

`propose` and `close` use a same-repository head. `create` runs after `did-user-agree-to-create-pr` and `is-cross-repo-pr`. The App token is minted on `propose`, `create`, and `close`.

## Tokens

`github-token` reads the client pull request and posts comments on it. It defaults to `github.token`.

`segment-schema-token` checks out the schema repository, pushes the bot branch, and opens, updates, or closes the schema pull request. Callers mint it with `actions/create-github-app-token` for owner `Consensys` and repository `segment-schema`, from the `segment-schema` environment, and pass `steps.app-token.outputs.token`.

## Callers

Mobile and Extension each keep `.github/workflows/draft-segment-schema-pr.yml`. Mobile sets `platform: mobile`. Extension sets `platform: extension`.

Pin this action to a github-tools commit SHA. The `@v1` tag follows a github-tools release.

`issue_comment` runs the workflow file from the default branch. `pull_request` runs the workflow file from the merge commit.

`propose` uses concurrency group `draft-segment-schema-propose-<N>` and cancels an in-progress run. `create` and `close` share `draft-segment-schema-write-<N>` and keep the in-progress run, so a propose does not cancel a create between `git push` and `pulls.create`.
