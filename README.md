# GitHub Tools

A place for internal GitHub tools to exist and be used. This currently only hosts a single script for getting the PR review load of the extension platform team but can be modified to include new tools or work with other teams.

## Usage

This isn't a module, but the module template has the best setup. It cannot be installed and should not be published. Just clone this repo and run the script `yarn get-review-metrics`

## Contributing

### Setup

- Install [Node.js](https://nodejs.org) version 20
  - If you are using [nvm](https://github.com/creationix/nvm#installation) (recommended) running `nvm use` will automatically choose the right node version for you.
- Install [Yarn v3](https://yarnpkg.com/getting-started/install)
- Run `yarn install` to install dependencies and run any required post-install scripts

### Testing and Linting

Run `yarn test` to run the tests once. To run tests on file changes, run `yarn test:watch`.

Run `yarn lint` to run the linter, or run `yarn lint:fix` to run the linter and fix any automatically fixable issues.
