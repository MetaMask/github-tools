# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0]

### Uncategorized

- ci: improve setup -e2e-env for iOS ([#197](https://github.com/MetaMask/github-tools/pull/197))
- Simplify fallback value on error in skip merge queue action ([#194](https://github.com/MetaMask/github-tools/pull/194))

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

[Unreleased]: https://github.com/MetaMask/github-tools/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/MetaMask/github-tools/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/MetaMask/github-tools/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MetaMask/github-tools/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/MetaMask/github-tools/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/MetaMask/github-tools/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/MetaMask/github-tools/compare/v1.1.0...v1.1.2
[1.1.0]: https://github.com/MetaMask/github-tools/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/MetaMask/github-tools/releases/tag/v1.0.0
