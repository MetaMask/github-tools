/* @ts-check */

// This file is used to define, among other configuration, rules that Yarn will
// execute when you run `yarn constraints`. These rules check the manifest of
// the package to ensure it follows a standard format.

/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types');

/**
 * Aliases for the Yarn type definitions, to make the code more readable.
 *
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Workspace} Workspace
 */

module.exports = defineConfig({
  async constraints({ Yarn }) {
    // This repository is a single package, so there is only one workspace.
    const workspace = Yarn.workspace();

    // The package must have a name.
    expectWorkspaceField(workspace, 'name');

    // The package must have a description that does not end in a period.
    expectWorkspaceDescription(workspace);

    // The package must specify a minimum Node version of 22.18, which is needed
    // to run `.mts` scripts directly.
    workspace.set('engines.node', '>=22.18.0');

    // If a dependency is listed under "dependencies", it should not be listed
    // under "devDependencies" with the same range.
    for (const dependency of Yarn.dependencies({ workspace })) {
      if (dependency.type !== 'devDependencies') {
        continue;
      }

      const isAlsoDependency = Yarn.dependencies({
        workspace,
        ident: dependency.ident,
      }).some(
        (other) =>
          other.type === 'dependencies' && other.range === dependency.range,
      );

      if (isAlsoDependency) {
        workspace.unset(`devDependencies.${dependency.ident}`);
      }
    }
  },
});

/**
 * Expect that the workspace has the given field, and that it is not null or an
 * empty string. If the field is not present, this will log an error, and
 * cause the constraint to fail.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {string} fieldName - The field to check.
 */
function expectWorkspaceField(workspace, fieldName) {
  const value = workspace.manifest[fieldName];
  if (value === undefined || value === null || value === '') {
    workspace.error(`Missing required field \`${fieldName}\`.`);
  }
}

/**
 * Expect that the workspace has a description, and that it is a non-empty
 * string. If the description is not present, or is null, this will log an
 * error, and cause the constraint to fail.
 *
 * This will also verify that the description does not end with a period.
 *
 * @param {Workspace} workspace - The workspace to check.
 */
function expectWorkspaceDescription(workspace) {
  expectWorkspaceField(workspace, 'description');

  const { description } = workspace.manifest;
  if (typeof description === 'string' && description.endsWith('.')) {
    workspace.set('description', description.slice(0, -1));
  }
}
