# Segment schema draft PR CLI

`yarn segment-schema:draft-pr` runs this CLI. The [composite action](../../.github/actions/draft-segment-schema-pr/README.md) calls the same entrypoint.

`--phase` is `generate` or `publish`. `--mode` is `propose`, `create`, or `close`. `--platform` is `mobile` or `extension`. Those three flags are required.

## Generate

`generate` reads the client pull request through the GitHub API and writes schema YAML into `--schema`. Point `--schema` at a checkout of the schema repository. The phase also writes `.segment-schema-draft-pr-summary.json` in that directory.

`GITHUB_TOKEN` is the client-repository token. When `GITHUB_OUTPUT` is set, generate records:

- `has_changes`
- `has_writable_changes` (true when generate produced at least one schema file)
- `branch` (`metamaskbot/<platform>-pr-<N>`)
- `summary_file`

```
GITHUB_TOKEN="<client token>" yarn segment-schema:draft-pr \
  --phase generate \
  --mode propose \
  --platform mobile \
  --schema /path/to/segment-schema-copy \
  --client-repository MetaMask/metamask-mobile \
  --pr-number 12 \
  --base-sha <pr-base-sha> \
  --head-sha <pr-head-sha>
```

`--previous-dir` is a checkout of the existing bot branch. Generate keeps descriptions and `labels.kpi` from that tree when it rewrites a file. `--default-library` overrides the unsorted library id (`metamask-mobile-unsorted` or `metamask-extension-unsorted`).

## Publish

`publish` reads `.segment-schema-draft-pr-summary.json` from `--schema` and posts comments or opens, updates, or closes the schema pull request.

`GITHUB_TOKEN` reads the client pull request and posts comments on it. `SEGMENT_SCHEMA_TOKEN` reads and writes the schema repository. `--segment-schema-repository` defaults to `Consensys/segment-schema`. `--segment-schema-base` defaults to `main`.

`--dry-run` logs `dry-run: skip GitHub writes` and returns.

The action also passes:

- `--pushed` after the schema branch push succeeds
- `--no-analytics-diff` when the gate found no analytics diff
- `--too-many-files` when the gate stopped YAML generation

`--pr-number` falls back to `PR_NUMBER`. `--client-repository` falls back to `GITHUB_REPOSITORY`.
