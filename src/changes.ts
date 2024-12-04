import { execSync } from 'child_process';
import fs from 'fs';

// Define the mapping of authors to teams
const authorToTeam = {
  // Add list from Mobile Planning teams.json file
};

// Get the date 6 months ago
const sixMonthsAgo = new Date();
sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
const sinceDate = sixMonthsAgo.toISOString().split('T')[0];

// Get the list of commits in the past 6 months
const commits = execSync(`git log --since=${sinceDate} --pretty=format:%H`, { encoding: 'utf-8' }).split('\n');

// Dictionary to track file updates and unknown authors
const fileUpdates = {};
const unknownAuthors = {};

// Loop over each commit and get the files changed and the author
commits.forEach(commit => {
  const commitInfo = execSync(`git show --pretty=format:%an --name-only ${commit}`, { encoding: 'utf-8' }).split('\n');
  const author = commitInfo[0];
  const filesChanged = commitInfo.slice(1);

  let team = 'unknown';
  if (authorToTeam[author]) {
    team = authorToTeam[author];
  } else {
    // Track unknown authors
    if (!unknownAuthors[author]) {
      unknownAuthors[author] = 0;
    }
    unknownAuthors[author]++;
  }

  filesChanged.forEach(file => {
    if (!fileUpdates[file]) {
      fileUpdates[file] = {};
    }
    if (!fileUpdates[file][team]) {
      fileUpdates[file][team] = 0;
    }
    fileUpdates[file][team]++;
  });
});

// Calculate entropy
const calculateEntropy = (teamUpdates) => {
  const totalUpdates = Object.values(teamUpdates).reduce((sum, count) => sum + count, 0);
  return -Object.values(teamUpdates).reduce((entropy, count) => {
    const p = count / totalUpdates;
    return entropy + (p * Math.log(p));
  }, 0);
};

// Identify files that require architecture decoupling
const filesForDecoupling = [];

Object.entries(fileUpdates).forEach(([file, teamUpdates]) => {
  if (Object.keys(teamUpdates).length > 1) {
    const totalUpdates = Object.values(teamUpdates).reduce((sum, count) => sum + count, 0);
    const entropy = calculateEntropy(teamUpdates);
    const score = entropy * totalUpdates;
    filesForDecoupling.push({ file, teamUpdates, score });
  }
});

// Sort files by score in descending order
filesForDecoupling.sort((a, b) => b.score - a.score);

// Define the header row for the decoupling CSV
const headers = 'File,Score,Team,Updates\n';

// Convert `filesForDecoupling` data to CSV format
const csvRows = filesForDecoupling.flatMap(({ file, teamUpdates, score }) =>
  Object.entries(teamUpdates).map(([team, count]) =>
    `${file},${score.toFixed(2)},${team},${count}`
  )
);

// Write the decoupling report to a CSV file
const decouplingCsvContent = headers + csvRows.join('\n');
fs.writeFileSync('decoupling_report.csv', decouplingCsvContent, 'utf8');
console.log('Decoupling CSV file has been created');

// Write the unknown authors to a separate CSV file
const unknownAuthorsCsvContent = 'Author,Commits\n' +
  Object.entries(unknownAuthors)
    .map(([author, commits]) => `${author},${commits}`)
    .join('\n');
fs.writeFileSync('unknown_authors.csv', unknownAuthorsCsvContent, 'utf8');
console.log('Unknown authors CSV file has been created');
