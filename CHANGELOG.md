# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0]

### Uncategorized

- Bump `actions/checkout` and `actions/setup-node` to the latest versions ([#173](https://github.com/MetaMask/github-tools/pull/173))
- Migrate remaining workflows to actions ([#169](https://github.com/MetaMask/github-tools/pull/169))
- ci: Add release automation ([#170](https://github.com/MetaMask/github-tools/pull/170))
- ci: Only run `add-team-label` test on PR ([#171](https://github.com/MetaMask/github-tools/pull/171))
- refactor!: Migrate remaining release-related workflows to actions ([#168](https://github.com/MetaMask/github-tools/pull/168))
- refactor!: Migrate project management workflows to actions ([#167](https://github.com/MetaMask/github-tools/pull/167))
- refactor!: Migrate release management workflows to actions ([#166](https://github.com/MetaMask/github-tools/pull/166))
- refactor!: Rewrite check changelog to action ([#164](https://github.com/MetaMask/github-tools/pull/164))
- fix: Use environment variables for script inputs in all workflows ([#162](https://github.com/MetaMask/github-tools/pull/162))
- chore: add minimal age to package installations ([#161](https://github.com/MetaMask/github-tools/pull/161))
- INFRA-3041:removed extra stable sync PR files ([#160](https://github.com/MetaMask/github-tools/pull/160))
- fix: add shouldExtractPrLinks to parseChangelog to populate prNumbers ([#159](https://github.com/MetaMask/github-tools/pull/159))
- Fix: Updated yarn version to 4.10.3 to resolve npmMinimalAgeGate error ([#156](https://github.com/MetaMask/github-tools/pull/156))
- fix(changelog-check): improve devDependencies section detection in git diffs ([#101](https://github.com/MetaMask/github-tools/pull/101))
- INFRA-3041: Stable sync workflow fixes ([#154](https://github.com/MetaMask/github-tools/pull/154))
- chore: sync extension+mobile changelog processes ([#157](https://github.com/MetaMask/github-tools/pull/157))
- chore: rename prefix automatically ([#155](https://github.com/MetaMask/github-tools/pull/155))
- test: uses foundry-version input ([#151](https://github.com/MetaMask/github-tools/pull/151))
- chore: rename column in post-validation script ([#153](https://github.com/MetaMask/github-tools/pull/153))
- chore: rename default E2E json report ([#149](https://github.com/MetaMask/github-tools/pull/149))
- Chore flaky tests fix ([#148](https://github.com/MetaMask/github-tools/pull/148))
- chore: fix e2e test reports ([#147](https://github.com/MetaMask/github-tools/pull/147))
- fix(release branch name): cleanup deprecated release branch name ([#146](https://github.com/MetaMask/github-tools/pull/146))
- Infra 2576 update changelog automatically ([#140](https://github.com/MetaMask/github-tools/pull/140))
- chore: updated default value flaky tests json report mobile ([#145](https://github.com/MetaMask/github-tools/pull/145))
- chore: avoid applesimutils warning due already installed pacakge ([#141](https://github.com/MetaMask/github-tools/pull/141))
- MCRM-8-Updated add-team-label worklow to use topology.json ([#137](https://github.com/MetaMask/github-tools/pull/137))
- fix(template): replace release pr template with latest version ([#139](https://github.com/MetaMask/github-tools/pull/139))
- chore: filter for push and schedule events to avoid forked PRs ([#138](https://github.com/MetaMask/github-tools/pull/138))
- INFRA-2999-Fix changelog error on mobile ([#136](https://github.com/MetaMask/github-tools/pull/136))
- Bump Xcode 16.2 to 16.3 to fix swift module compilation issue ([#135](https://github.com/MetaMask/github-tools/pull/135))
- fix(sign off list): remove legacy list of teams ([#134](https://github.com/MetaMask/github-tools/pull/134))
- ci: update auto-changelog to v5.1.0 ([#133](https://github.com/MetaMask/github-tools/pull/133))
- switch yarn v1 to yarn v3 at setup e2e environment action ([#132](https://github.com/MetaMask/github-tools/pull/132))
- sha-pin self refs ([#131](https://github.com/MetaMask/github-tools/pull/131))
- Self hosted runners config ([#130](https://github.com/MetaMask/github-tools/pull/130))
- ci: fix failure conclusion ([#127](https://github.com/MetaMask/github-tools/pull/127))
- chore(branches): rename Version-vx.y.z branches into release/x.y.z ([#125](https://github.com/MetaMask/github-tools/pull/125))
- ci: default to 1 day for lookback PRs for post validation ([#124](https://github.com/MetaMask/github-tools/pull/124))
- INFRA-2911-Skip version bumping for hotfixes ([#119](https://github.com/MetaMask/github-tools/pull/119))
- INFRA-2911-Skip generating commits.csv for hotfixes ([#118](https://github.com/MetaMask/github-tools/pull/118))
- ci: small fixes ([#117](https://github.com/MetaMask/github-tools/pull/117))
- ci: add flaky tests bot workflow ([#114](https://github.com/MetaMask/github-tools/pull/114))
- INFRA-2849: Made extension work with release/x.y.z branch syntax ([#116](https://github.com/MetaMask/github-tools/pull/116))
- chore(master): rename master branch into stable ([#115](https://github.com/MetaMask/github-tools/pull/115))
- INFRA-2867: Skip version bump PR creation if already exists, commit in main ([#112](https://github.com/MetaMask/github-tools/pull/112))
- fix: stable sync secret ([#113](https://github.com/MetaMask/github-tools/pull/113))
- INFRA-2867-Added chore prefix to PR, await for create release, remove commits.csv from changelog pr ([#111](https://github.com/MetaMask/github-tools/pull/111))
- feat(INFRA-2864): add remove rca gha ([#109](https://github.com/MetaMask/github-tools/pull/109))
- INFRA-2867-Fix workflow inputs to allow branch name ([#108](https://github.com/MetaMask/github-tools/pull/108))
- ci: disable the google sheet updates for the testing tracker ([#107](https://github.com/MetaMask/github-tools/pull/107))
- ci: adapt regex to detect snap tests changes ([#104](https://github.com/MetaMask/github-tools/pull/104))
- feat: capture additional RCA fields ( repository + issue url ) ([#103](https://github.com/MetaMask/github-tools/pull/103))
- fix(checkout branch): decription was not correct ([#102](https://github.com/MetaMask/github-tools/pull/102))
- feat(base branch): make it possible to define name of release PR base branch ([#99](https://github.com/MetaMask/github-tools/pull/99))
- Adapt post validation script to detect if PRs have automated tests ([#100](https://github.com/MetaMask/github-tools/pull/100))
- ci: adapt the post-merge-validation job to track progress in a sheet ([#98](https://github.com/MetaMask/github-tools/pull/98))
- ci: adapt PR size job to add sizes label ([#96](https://github.com/MetaMask/github-tools/pull/96))
- ci: add RCA-needed label on RCA workflow ([#95](https://github.com/MetaMask/github-tools/pull/95))
- feat: post validation bot to add a checklist in `feat` and `perf` PRs ([#94](https://github.com/MetaMask/github-tools/pull/94))
- feat(INFRA-2772): add automatic main version bump after release PR creation ([#86](https://github.com/MetaMask/github-tools/pull/86))
- feat: optimize changelog check for package.json changes ([#84](https://github.com/MetaMask/github-tools/pull/84))
- feat(stable-sync): Move stable sync process within github tools ([#82](https://github.com/MetaMask/github-tools/pull/82))
- fix: "Create Release Pull Request" on Extension ([#79](https://github.com/MetaMask/github-tools/pull/79))
- release: establish a new Commit Type called `release` ([#76](https://github.com/MetaMask/github-tools/pull/76))
- feat(stable-sync): improve the script for extension pipeline ([#75](https://github.com/MetaMask/github-tools/pull/75))
- feat(gh-action): align version management mobile and extension ([#73](https://github.com/MetaMask/github-tools/pull/73))

[Unreleased]: https://github.com/MetaMask/github-tools/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MetaMask/github-tools/releases/tag/v1.0.0
