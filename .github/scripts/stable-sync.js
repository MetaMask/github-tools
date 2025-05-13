#!/usr/bin/env node

// USAGE:
// This will create/update a local stable-sync branch
// and get it in the state needed for a stable-sync PR
// Once the script successfully completes, you just
// need to push the branch to the remote repo. This will
// likely require a `git push --force`
//
// Usage: node stable-sync.js [branch-name]
// If no branch name is provided, defaults to 'stable-sync'

const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

async function runGitCommands() {
  // Get branch name from command line arguments or use default
  const branchName = process.argv[2] || 'stable-main';

  try {
    try {
      // Check if the branch already exists
      const { stdout: branchExists } = await exec(
        `git rev-parse --quiet --verify ${branchName}`,
      );
      if (branchExists.trim()) {
        // Branch exists, so simply check it out
        await exec(`git checkout ${branchName}`);
        console.log(`Checked out branch: ${branchName}`);
      } else {
        throw new Error(
          'git rev-parse --quiet --verify failed. Branch hash empty',
        );
      }
    } catch (error) {
      if (error.stdout === '') {
        console.warn(
          `Branch does not exist, creating new ${branchName} branch.`,
        );

        // Branch does not exist, create and check it out
        await exec(`git checkout -b ${branchName}`);
        console.log(`Created and checked out branch: ${branchName}`);
      } else {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }

    await exec('git fetch');
    console.log('Executed: git fetch');

    await exec('git reset --hard origin/stable');
    console.log('Executed: git reset --hard origin/stable');

    try {
      await exec('git merge origin/main');
      console.log('Executed: git merge origin/main');
    } catch (error) {
      // Handle the error but continue script execution
      if (
        error.stdout.includes(
          'Automatic merge failed; fix conflicts and then commit the result.',
        )
      ) {
        console.warn(
          'Merge conflict encountered. Continuing script execution.',
        );
      } else {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }

    await exec('git add .');
    await exec('git restore --source origin/main .');
    console.log('Executed: it restore --source origin/main .');

    await exec('git checkout origin/main -- .');
    console.log('Executed: git checkout origin/main -- .');

    await exec('git checkout origin/stable -- CHANGELOG.md');
    console.log('Executed: git checkout origin/stable -- CHANGELOG.md');

    // Mobile Only
    await exec('git checkout origin/stable -- bitrise.yml');
    console.log('Executed: git checkout origin/stable -- bitrise.yml');

    // Mobile Only
    await exec('git checkout origin/stable -- android/app/build.gradle');
    console.log('Executed: git checkout origin/stable -- android/app/build.gradle');

    // Mobile Only
    await exec('git checkout origin/stable -- ios/MetaMask.xcodeproj/project.pbxproj');
    console.log('Executed: git checkout origin/stable -- ios/MetaMask.xcodeproj/project.pbxproj');

    // Mobile Only
    await exec('git checkout origin/stable -- package.json');
    console.log('Executed: git checkout origin/stable -- package.json');

    // Extension Only
    // const { stdout: packageJsonContent } = await exec(
    //   'git show origin/master:package.json',
    // );
    // const packageJson = JSON.parse(packageJsonContent);
    // const packageVersion = packageJson.version;

    // await exec(`yarn version "${packageVersion}"`);
    // console.log('Executed: yarn version');

    await exec('git add .');
    console.log('Executed: git add .');

    await exec(`git commit -m "Merge origin/main into ${branchName}" --no-verify`);
    console.log('Executed: git commit');

    console.log(`Your local ${branchName} branch is now ready to become a PR.`);
    console.log('You likely now need to do `git push --force`');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

runGitCommands();
