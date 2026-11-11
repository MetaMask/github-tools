/* @ts-check */

// This file is used to define, among other configuration, rules that Yarn will
// execute when you run `yarn constraints`. These rules check the manifest of
// the package to ensure it follows a standard format.

/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types');

/**
 * Aliases for the Yarn type definitions, to make the code more readable.
 *
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Yarn} Yarn
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Workspace} Workspace
 */

module.exports = defineConfig({
  async constraints({ Yarn }) {
    for (const workspace of Yarn.workspaces()) {
      // The package must have a name and a description.
      expectWorkspaceField(workspace, 'name');
      expectWorkspaceField(workspace, 'description');

      // The description cannot end with a period.
      const description = workspace.manifest.description;
      if (typeof description === 'string' && description.endsWith('.')) {
        workspace.set('description', description.slice(0, -1));
      }

      // The package must specify a minimum Node version of 22.18, which is
      // needed to run `.mts` scripts directly.
      workspace.set('engines.node', '>=22.18.0');

      // If a dependency is listed under "dependencies", it should not be
      // listed under "devDependencies".
      for (const dependency of Yarn.dependencies({ workspace })) {
        if (dependency.type !== 'devDependencies') {
          continue;
        }

        const isAlsoDependency = Yarn.dependencies({
          workspace,
          ident: dependency.ident,
        }).some((other) => other.type === 'dependencies');

        if (isAlsoDependency) {
          workspace.unset(`devDependencies.${dependency.ident}`);
        }
      }
    }
  },
});

/**
 * Expect that the workspace has the given field set to a non-empty value.
 *
 * @param {Workspace} workspace - The workspace to check.
 * @param {string} fieldName - The name of the manifest field.
 */
function expectWorkspaceField(workspace, fieldName) {
  const value = workspace.manifest[fieldName];
  if (value === undefined || value === null || value === '') {
    workspace.error(`Missing required field \`${fieldName}\`.`);
  }
}
