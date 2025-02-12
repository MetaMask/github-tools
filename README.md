# GitHub Tools

A place for internal GitHub tools to exist and be used.

## Usage

This repository holds a collection of scripts which are intended to be run locally:

- `yarn get-review-metrics`: Gets the PR load of the extension platform team.
- `yarn count-references-to-contributor-docs`: Counts the number of references to the `contributor-docs` repo in pull request comments.

- `yarn run slack:release-testing`: Publishes a notification to slack for active releases regarding the release testing statuses.

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
