# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MetaMask/github-tools/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MetaMask/github-tools/releases/tag/v1.0.0
