import fs from 'fs';
import simpleGit from 'simple-git';
import { Octokit } from '@octokit/rest';

import axios from 'axios';

// "GITHUB_TOKEN" is an automatically generated, repository-specific access token provided by GitHub Actions.
const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.log('GITHUB_TOKEN not found');
  process.exit(1);
}

// Initialize Octokit with your GitHub token
const octokit = new Octokit({ auth: githubToken });

// https://github.com/MetaMask/MetaMask-planning/blob/main/teams.json lookup from here
async function getTeam(repository, prNumber) {
  try {
    const { data: prData } = await octokit.pulls.get({
      owner: 'MetaMask',
      repo: repository,
      pull_number: prNumber[1],
    });

    const author = prData.user.login; // PR author's GitHub username

    const teamsJsonUrl =
      'https://raw.githubusercontent.com/MetaMask/MetaMask-planning/refs/heads/main/teams.json';
    const githubToken = process.env.GITHUB_TOKEN;

    const response = await axios.get(teamsJsonUrl, {
      headers: { Authorization: `token ${githubToken}` },
    });

    // Check if the response is successful and contains data
    if (response.status !== 200 || !response.data) {
      console.error(
        `Invalid response when fetching teams.json: ${response.status}`,
      );
      return ['Unknown'];
    }

    const teamsJson = response.data;

    // Step 3: Match the PR author's username to a team
    const team = teamsJson[author];

    // Step 4: Return the team name or 'Unknown' if not found
    return team || 'Unknown';

  } catch (error) {
    console.error(
      `Error fetching team for PR #${prNumber}:`,
      error.message || error,
    );
    return 'Unknown';
  }
}

// Function to filter commits based on unique commit messages and group by teams
async function filterCommitsByTeam(platform, branchA, branchB) {

  const MAX_COMMITS = 500; // Limit the number of commits to process
  console.log('Filtering commits by team...');

  var repository = '';

  switch (platform) {
    case 'mobile':
      repository = 'metamask-mobile';
      break;
    case 'extension':
      repository = 'metamask-extension';
      break;
    default:
      repository = 'metamask-mobile';
  }

  try {
    const git = simpleGit();

    // Fetch all branches from remote to ensure we have the latest references
    console.log('Fetching branches from remote...');
    await git.fetch('origin', ['--all']);

    // Check if branches exist
    console.log(`Checking if branches exist: ${branchA} and ${branchB}`);
    
    try {
      await git.revparse(['--verify', branchA]);
      console.log(`✓ Branch ${branchA} exists`);
    } catch (error) {
      console.error(`✗ Branch ${branchA} does not exist locally`);
      // Try to check if it exists remotely
      try {
        await git.revparse(['--verify', `origin/${branchA}`]);
        console.log(`✓ Branch origin/${branchA} exists, using remote reference`);
        branchA = `origin/${branchA}`;
      } catch (remoteError) {
        console.error(`✗ Branch ${branchA} does not exists remotely either`);
        throw new Error(`Branch ${branchA} not found locally or remotely`);
      }
    }

    try {
      await git.revparse(['--verify', branchB]);
      console.log(`✓ Branch ${branchB} exists`);
    } catch (error) {
      console.error(`✗ Branch ${branchB} does not exist locally`);
      // Try to check if it exists remotely
      try {
        await git.revparse(['--verify', `origin/${branchB}`]);
        console.log(`✓ Branch origin/${branchB} exists, using remote reference`);
        branchB = `origin/${branchB}`;
      } catch (remoteError) {
        console.error(`✗ Branch ${branchB} does not exists remotely either`);
        throw new Error(`Branch ${branchB} not found locally or remotely`);
      }
    }

    const logOptions = {
      from: branchB,
      to: branchA,
      format: {
        hash: '%H',
        author: '%an',
        message: '%s',
      },
    };

    const log = await git.log(logOptions);

    console.log(`Total commits between ${branchA} and ${branchB}: ${log.total}`);
    console.log(`Processing up to ${Math.min(log.all.length, MAX_COMMITS)} commits...`);

    const commitsByTeam = {};



    for (const commit of log.all) {
      const { author, message, hash } = commit;
      if (Object.keys(commitsByTeam).length >= MAX_COMMITS) {
        console.error('Too many commits for script to work');
        break;
      }

      // Extract PR number from the commit message using regex
      const prMatch = message.match(/\(#(\d{4,5})\)$/u);
      if (prMatch) {
        const prLink = prMatch
          ? `https://github.com/MetaMask/${repository}/pull/${prMatch[1]}`
          : '';
        const team = await getTeam(repository, prMatch);

        // Initialize the team's commits array if it doesn't exist
        if (!commitsByTeam[team]) {
          commitsByTeam[team] = [];
        }

        commitsByTeam[team].push({
          message,
          author,
          hash: hash.substring(0, 7),
          prLink,
        });
      }
    }

    // Count total processed commits after the loop
    const totalProcessed = Object.values(commitsByTeam)
      .reduce((sum, commits) => sum + commits.length, 0);

    console.log(`Total commits eligible for commits.csv : ${totalProcessed}`);
    
    return commitsByTeam;

  } catch (error) {
    console.error(error);
    return {};
  }
}

function formatAsCSV(commitsByTeam) {
  const csvContent = [];
  for (const [team, commits] of Object.entries(commitsByTeam)) {
    commits.forEach((commit) => {
      const row = [
        stripDelimiter(commit.message, ','),
        stripDelimiter(commit.author, ','),
        commit.prLink,
        stripDelimiter(team, ','),
        ,
        assignChangeType(commit.message),
      ];
      csvContent.push(row.join(','));
    });
  }
  csvContent.unshift('Commit Message,Author,PR Link,Team,Change Type');

  return csvContent;
}

// Helper function to strip delimiter from CSV fields so they can be properly imported automatically later
function stripDelimiter(inputString, delimiter) {
  // Create a regex dynamically based on the provided delimiter
  const regex = new RegExp(delimiter, 'g');
  return inputString.replace(regex, '');
}

// Helper function to escape CSV fields
function escapeCSV(field) {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`; // Encapsulate in double quotes and escape existing quotes
  }
  return field;
}
// Helper function to create change type
function assignChangeType(field) {
  if (field.includes('feat')) return 'Added';
  else if (
    field.includes('cherry') ||
    field.includes('bump') ||
    field.includes('release')
  )
    return 'Ops';
  else if (
    field.includes('chore') ||
    field.includes('test') ||
    field.includes('ci') ||
    field.includes('docs') ||
    field.includes('refactor')
  )
    return 'Changed';
  else if (field.includes('fix')) return 'Fixed';

  return 'Unknown';
}

async function main() {
  const args = process.argv.slice(2);
  const fileTitle = 'commits.csv';

  if (args.length !== 4) {
    console.error(
      'Usage: node generate-rc-commits.mjs platform branchA branchB',
    );
    console.error('Received:', args, ' with length:', args.length);
    process.exit(1);
  }

  const platform = args[0];
  const branchA = args[1];
  const branchB = args[2];
  const gitDir = args[3];

  // Change the working directory to the git repository path
  // Since this is invoked by a shared workflow, the working directory is not guaranteed to be the repository root
  process.chdir(gitDir);

  console.log(
    `Generating CSV file for commits between ${branchA} and ${branchB} on ${platform} platform...`,
  );

  const commitsByTeam = await filterCommitsByTeam(platform, branchA, branchB);

  if (Object.keys(commitsByTeam).length === 0) {
    console.log('No commits found.');
  } else {
    const csvContent = formatAsCSV(commitsByTeam);
    fs.writeFileSync(fileTitle, csvContent.join('\n'));
    console.log('CSV file ', fileTitle, ' created successfully.');
  }
}

main();
