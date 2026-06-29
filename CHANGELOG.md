# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.15.0]

### Added

- Add `update-major-version-tag` reusable composite action ([#267](https://github.com/MetaMask/github-tools/pull/267))
  - This action can be used to update the major version tag (e.g., `v1`) for repositories containing GitHub Actions.

## [1.14.0]

### Added

- Support OTA branches in `release-branch-sync` action ([#263](https://github.com/MetaMask/github-tools/pull/263))
- Add `playwright-test-health-report` action for creating reports for Playwright tests, and posting to Slack ([#262](https://github.com/MetaMask/github-tools/pull/262))

### Fixed

- Allow `release-branch-sync` action to reuse branch ([#264](https://github.com/MetaMask/github-tools/pull/264))

## [1.13.0]

### Added

- Add `rename-after-install-and-build` input to the `publish-preview` reusable workflow ([#254](https://github.com/MetaMask/github-tools/pull/254))
  - When set to `true`, the workflow installs dependencies and runs the build _before_ renaming workspace manifests to the preview NPM scope. This ensures snap artifacts (e.g. `dist/bundle.js`, `snap.manifest.json` and its `source.shasum`) are produced with the original `@metamask/...` package name.
  - Defaults to `false` to preserve existing behavior for non-snap consumers.
- Add `BUILD_ENV` secret input to the `publish-preview` reusable workflow
  - Accepts a JSON object of environment variables that will be passed to the build step (e.g. `'{"API_URL":"https://...","LOG_LEVEL":"all"}'`). Useful when the build command needs additional configuration or secret values to produce a valid preview build.

## [1.12.0]

### Changed

- Bump `actionlint` from `1.7.7` to `1.7.12` in the `lint-workflows` workflow ([#259](https://github.com/MetaMask/github-tools/pull/259))

## [1.11.0]

### Added

- Add optional `planning-token` to `add-team-label` action ([#257](https://github.com/MetaMask/github-tools/pull/257))

## [1.10.0]

### Added

- Add `get-token` action to get short-lived access token using OIDC ([#255](https://github.com/MetaMask/github-tools/pull/255))

## [1.9.4]

### Fixed

- fix: drop deleted bitrise.yml from stable-sync preserve list ([#251](https://github.com/MetaMask/github-tools/pull/251))
- ci: fix the announce-release Slack post ([#250](https://github.com/MetaMask/github-tools/pull/250))

## [1.9.3]

### Fixed

- fix: fix `release-branch-sync` failure when there are too many open PRs more recent than the release PR ([#247](https://github.com/MetaMask/github-tools/pull/247))

## [1.9.2]

### Changed

- chore: bump Yarn to 4.14.1 ([#244](https://github.com/MetaMask/github-tools/pull/244))

## [1.9.1]

### Changed

- chore: use single header row for post merge spreadsheet ([#242](https://github.com/MetaMask/github-tools/pull/242))

## [1.9.0]

### Changed

- ci: update all actions to their newest versions to solve "Node.js 20 actions are deprecated" (#234)
- test: multi label + update title (#233)
- test: MMQA-1609 - feature flag registry slack notification and create PR (#229)
- Auto-skip release validation columns from PR labels on main release tabs (#231)

## [1.8.0]

### Added

- Add reusable `publish-preview` workflow for publishing preview builds ([#223](https://github.com/MetaMask/github-tools/pull/223), [#227](https://github.com/MetaMask/github-tools/pull/227))

## [1.7.1]

### Fixed

- fix: resolve merge-approved-pr action path for cross-repo workflow calls ([#224](https://github.com/MetaMask/github-tools/pull/224))

## [1.7.0]

### Changed

- chore: get latest ruby versions and sets the default ruby version to 3.2.9 ([#220](https://github.com/MetaMask/github-tools/pull/220))
- Improve `merge-approved-pr` action with `merge-method` and `verify-version-bump` inputs, and harden bash inputs as env vars ([#201](https://github.com/MetaMask/github-tools/pull/201))

## [1.6.0]

### Changed

- Rename changelog branches to release-changelog/${version} ([#217](https://github.com/MetaMask/github-tools/pull/217))

## [1.5.0]

### Added

- Add workflow **post-relay-subsidy-balance** to post Relay subsidy balance reports to Slack ([#211](https://github.com/MetaMask/github-tools/pull/211))

### Changed

- chore: removes restore-keys from yarn install to prevent cache pollution ([#213](https://github.com/MetaMask/github-tools/pull/213))
- feat: updated replay balance tracker workflow to run at 11:53 and 23:53 ([#212](https://github.com/MetaMask/github-tools/pull/212))

### Fixed

- fix: create_pr_if_not_exists check for closed/merged branches too ([#208](https://github.com/MetaMask/github-tools/pull/208))

## [1.4.4]

### Changed

- add refactor items to release tracker ([#209](https://github.com/MetaMask/github-tools/pull/209))

## [1.4.3]

### Changed

- add chore items to release tracker ([#206](https://github.com/MetaMask/github-tools/pull/206))

### Fixed

- fix: consolidate release scripts and shared git utilities ([#195](https://github.com/MetaMask/github-tools/pull/195))

## [1.4.2]

### Fixed

- Remove need for fetching repository by using GitHub API in skip merge queue check ([#204](https://github.com/MetaMask/github-tools/pull/204))

## [1.4.1]

### Fixed

- Replace CocoaPods specs cache with Pods cache to prevent stale trunk errors in `setup-e2e-env` action ([#202](https://github.com/MetaMask/github-tools/pull/202))

## [1.4.0]

### Changed

- Updated setup-e2e-env action for iOS builds by adding CocoaPods specs caching and enabling Yarn global cache ([#197](https://github.com/MetaMask/github-tools/pull/197))

## [1.3.0]

### Added

- Add action which determines if the merge queue can be safely skipped ([#191](https://github.com/MetaMask/github-tools/pull/191))

## [1.2.0]

### Added

- Created workflow **release-branch-sync** to sync release, stable branches in ([#189](https://github.com/MetaMask/github-tools/pull/189))
- Create workflow **merge-previous-releases** to automate Merging old release branches into new release branches workflow in ([#186](https://github.com/MetaMask/github-tools/pull/186))

## [1.1.4]

### Fixed

- Checkout GitHub tools using ref instead of main branch in `flaky-test-report` and `update-release-changelog` actions ([#184](https://github.com/MetaMask/github-tools/pull/184))

## [1.1.3]

### Fixed

- Prevent changelog PR creation when branches are in sync ([#177](https://github.com/MetaMask/github-tools/pull/177))

## [1.1.2]

### Added

- Adds ability to merge Version Bump PRs with PR comment ([#179](https://github.com/MetaMask/github-tools/pull/179))

### Changed

- Update to use topology.json instead of old teams.json for commits.csv during create release pr ([#180](https://github.com/MetaMask/github-tools/pull/180))

## [1.1.0]

### Added

- Add merging GitHub action ([#172](https://github.com/MetaMask/github-tools/pull/172))

### Changed

- Bump `@metamask/auto-changelog` from `^5.1.0` to `^5.2.0` ([#175](https://github.com/MetaMask/github-tools/pull/175))
  - Adds deduplication for commits with no PR number in subject (non-"Squash & Merge" commits)
  - Merge commits are now deduplicated using commit body instead of the generic merge subject

## [1.0.0]

### Added

- Initial release of `github-tools` ([#174](https://github.com/MetaMask/github-tools/pull/174))
  - `github-tools` was previously used by referencing commit hashes, but this is no longer recommended.

### Changed

- **BREAKING:** Migrate all reusable workflows to composite actions ([#164](https://github.com/MetaMask/github-tools/pull/164), [#166](https://github.com/MetaMask/github-tools/pull/166), [#167](https://github.com/MetaMask/github-tools/pull/167), [#168](https://github.com/MetaMask/github-tools/pull/168), [#169](https://github.com/MetaMask/github-tools/pull/169))
  - All actions are now in the `.github/actions` folder.
  - Instead of passing secrets, actions now use inputs for things like tokens.
  - The `github-tools-version` input of some workflows was removed, since the actions can now determine which version to use automatically.
  - Some inputs were renamed for consistency across actions.
- Bump `actions/checkout` and `actions/setup-node` to `v6` ([#173](https://github.com/MetaMask/github-tools/pull/173))

[Unreleased]: https://github.com/MetaMask/github-tools/compare/v1.15.0...HEAD
[1.15.0]: https://github.com/MetaMask/github-tools/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/MetaMask/github-tools/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/MetaMask/github-tools/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/MetaMask/github-tools/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/MetaMask/github-tools/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/MetaMask/github-tools/compare/v1.9.4...v1.10.0
[1.9.4]: https://github.com/MetaMask/github-tools/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/MetaMask/github-tools/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/MetaMask/github-tools/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/MetaMask/github-tools/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/MetaMask/github-tools/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/MetaMask/github-tools/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/MetaMask/github-tools/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/MetaMask/github-tools/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/MetaMask/github-tools/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/MetaMask/github-tools/compare/v1.4.4...v1.5.0
[1.4.4]: https://github.com/MetaMask/github-tools/compare/v1.4.3...v1.4.4
[1.4.3]: https://github.com/MetaMask/github-tools/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/MetaMask/github-tools/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/MetaMask/github-tools/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/MetaMask/github-tools/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/MetaMask/github-tools/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MetaMask/github-tools/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/MetaMask/github-tools/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/MetaMask/github-tools/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/MetaMask/github-tools/compare/v1.1.0...v1.1.2
[1.1.0]: https://github.com/MetaMask/github-tools/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/MetaMask/github-tools/releases/tag/v1.0.0
