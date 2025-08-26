import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { GitHub } from '@actions/github/lib/utils';
import { google } from 'googleapis';

interface Label {
  name: string;
  color: string;
  description: string;
}

const RCA_NEEDED_LABEL: Label = {
  name: 'RCA-needed',
  color: 'FF0000',
  description: 'Issue requires Root Cause Analysis',
};

// Google Sheets configuration from environment variables
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

interface RcaFormResponse {
  issueNumber: string;
  timestamp: string;
  [key: string]: any;
}

async function main(): Promise<void> {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed('GITHUB_TOKEN not found');
      process.exit(1);
    }

    // Google Sheets API credentials (base64 encoded service account JSON)
    const googleCredentials = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!googleCredentials) {
      core.setFailed('GOOGLE_SHEETS_CREDENTIALS not found');
      process.exit(1);
    }

    // Validate sheet configuration
    if (!SPREADSHEET_ID) {
      core.setFailed('SPREADSHEET_ID not configured');
      process.exit(1);
    }
    if (!SHEET_NAME) {
      core.setFailed('SHEET_NAME not configured');
      process.exit(1);
    }

    const isDryRun = process.env.DRY_RUN === 'true';

    const octokit: InstanceType<typeof GitHub> = getOctokit(githubToken);
    const repoOwner = context.repo.owner;
    const repoName = context.repo.repo;

    console.log(`Starting Google Sheets-based RCA label removal (Dry Run: ${isDryRun})`);
    console.log(`Repository: ${repoOwner}/${repoName}`);
    console.log(`Sheet ID: ${SPREADSHEET_ID}`);
    console.log(`Sheet Name: ${SHEET_NAME}`);

    // Initialize Google Sheets API
    const sheets = await initializeGoogleSheets(googleCredentials);

    // Get all RCA form responses from the sheet
    const rcaResponses = await fetchRcaResponses(sheets);
    console.log(`Found ${rcaResponses.length} RCA responses in Google Sheets`);

    // Get all closed issues with RCA-needed label
    const issuesWithRcaNeeded = await getIssuesWithRcaLabel(
      octokit,
      repoOwner,
      repoName
    );

    console.log(`Found ${issuesWithRcaNeeded.length} issues with RCA-needed label`);

    let removedCount = 0;
    let skippedCount = 0;

    let failedCount = 0;
    const failedIssues: number[] = [];

    for (const issue of issuesWithRcaNeeded) {
      console.log(`\n📋 Processing issue #${issue.number}: ${issue.title}`);

      try {
        // Check if issue has RCA response in Google Sheets
        const hasRcaResponse = rcaResponses.some(
          response => response.issueNumber === issue.number.toString()
        );

        if (hasRcaResponse) {
          console.log(`✅ RCA response found in Google Sheets for issue #${issue.number}`);

          if (!isDryRun) {
            // Remove the RCA-needed label
            await removeLabelFromIssue(
              octokit,
              repoOwner,
              repoName,
              issue.number,
              RCA_NEEDED_LABEL.name
            );

            console.log(`✅ Successfully removed RCA-needed label from issue #${issue.number}`);
            removedCount++;
          } else {
            console.log(`🔍 [DRY RUN] Would remove label from issue #${issue.number}`);
            removedCount++;
          }
        } else {
          console.log(`⏳ No RCA found in sheet for issue #${issue.number} - skipping`);
          skippedCount++;
        }
      } catch (error) {
        console.error(`❌ Failed to process issue #${issue.number}: ${error.message}`);
        failedCount++;
        failedIssues.push(issue.number);
        // Continue processing other issues
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`  - Repository: ${repoOwner}/${repoName}`);
    console.log(`  - Issues processed: ${issuesWithRcaNeeded.length}`);
    console.log(`  - Labels ${isDryRun ? 'would be' : ''} removed: ${removedCount}`);
    console.log(`  - Issues skipped (no RCA in sheet): ${skippedCount}`);

    if (failedCount > 0) {
      console.log(`  - ⚠️  Issues failed: ${failedCount}`);
      console.log(`  - Failed issue numbers: ${failedIssues.join(', ')}`);
      core.warning(`Some issues failed to process: ${failedIssues.join(', ')}`);
    }

    // Set appropriate exit status
    if (failedCount > 0 && removedCount === 0) {
      core.setFailed('All label removal attempts failed');
      process.exit(1);
    } else if (failedCount > 0) {
      console.log(`\n⚠️  Completed with ${failedCount} failures. Check logs for details.`);
    } else {
      console.log(`\n✅ All operations completed successfully!`);
    }

  } catch (error) {
    core.setFailed(`Error in Google Sheets RCA label removal: ${error.message}`);
    process.exit(1);
  }
}

async function initializeGoogleSheets(credentials: string): Promise<any> {
  // Decode base64 credentials
  const credentialsJson = JSON.parse(
    Buffer.from(credentials, 'base64').toString('utf-8')
  );

  // Initialize Google Sheets API client
  const auth = new google.auth.GoogleAuth({
    credentials: credentialsJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

async function fetchRcaResponses(sheets: any): Promise<RcaFormResponse[]> {
  try {
    // Fetch data from the Google Sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:J`, // Covers columns A through J
    });

    const rows = response.data.values || [];

    if (rows.length <= 1) {
      // No data rows (only header or empty)
      return [];
    }

    // Process data rows (skip header row at index 0)
    // Column indices based on actual sheet:
    // 0: Timestamp, 1: Email, 2: Github Repository, 3: Github Issue URL, 4: Issue Number
    const ISSUE_NUMBER_COLUMN = 4;

    const responses: RcaFormResponse[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      // Skip empty rows
      if (!row || row.length === 0) {
        continue;
      }

      // Get issue number from column E (index 4)
      const issueNumberValue = row[ISSUE_NUMBER_COLUMN];

      if (issueNumberValue) {
        // Extract just the numeric part from the issue number
        // Handles formats like: "18454", "#18454", "issue-18454", etc.
        const issueMatch = issueNumberValue.toString().match(/\d+/);
        if (issueMatch) {
          responses.push({
            issueNumber: issueMatch[0],
            timestamp: row[0] || '', // Column A: Timestamp
            // Additional fields can be added if needed:
            // repository: row[2], // Column C: Github Repository
            // issueUrl: row[3],   // Column D: Github Issue URL
          });
          console.log(`  Found RCA for issue #${issueMatch[0]} submitted on ${row[0]}`);
        }
      }
    }

    return responses;
  } catch (error) {
    console.error('Error fetching Google Sheets data:', error);
    throw error;
  }
}

async function getIssuesWithRcaLabel(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string
): Promise<any[]> {
  const allIssues: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetIssuesWithRcaLabel($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(labels: ["RCA-needed"], states: CLOSED, first: 100, after: $cursor) {
            nodes {
              id
              number
              title
              createdAt
              closedAt
              labels(first: 10) {
                nodes {
                  id
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    const result: any = await octokit.graphql(query, { owner, repo, cursor });
    const issues = result.repository.issues;

    allIssues.push(...(issues.nodes || []));
    hasNextPage = issues.pageInfo.hasNextPage;
    cursor = issues.pageInfo.endCursor;

    if (hasNextPage) {
      console.log(`  Fetching more issues... (${allIssues.length} so far)`);
    }
  }

  return allIssues;
}

async function removeLabelFromIssue(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string
): Promise<void> {
  try {
    // Use REST API to remove label from issue
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    });
  } catch (error) {
    // If label doesn't exist on issue, the API will throw 404
    // This is not an error for our use case, so we can safely ignore it
    if (error.status !== 404) {
      throw error;
    }
  }
}

// Run the main function
main().catch((error: Error): void => {
  console.error(error);
  process.exit(1);
});