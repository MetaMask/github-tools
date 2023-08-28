# GitHub Tools

A place for internal GitHub tools to exist and be used.

## Usage

This repository holds a collection of scripts which are intended to be run locally:

- `yarn get-review-metrics`: Gets the PR load of the extension platform team.
- `GITHUB_AUTH_TOKEN="<your GitHub token>" yarn count-references-to-contributor-docs`: Counts the number of references to the `contributor-docs` repo in pull request comments.

## Contributing

### Setup

- Install [Node.js](https://nodejs.org) version 20
  - If you are using [nvm](https://github.com/creationix/nvm#installation) (recommended) running `nvm use` will automatically choose the right node version for you.
- Install [Yarn v3](https://yarnpkg.com/getting-started/install)
- Run `yarn install` to install dependencies and run any required post-install scripts

### Testing and Linting

Run `yarn test` to run the tests once. To run tests on file changes, run `yarn test:watch`.

Run `yarn lint` to run the linter, or run `yarn lint:fix` to run the linter and fix any automatically fixable issues.
