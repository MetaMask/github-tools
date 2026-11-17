// Note: These packages are installed at runtime in the GitHub Actions workflow
// @ts-expect-error - @actions/core is not in devDependencies
import * as rawCore from '@actions/core';
// @ts-expect-error - @actions/github is not in devDependencies
import {
  context as rawContext,
  getOctokit as rawGetOctokit,
} from '@actions/github';
// @ts-expect-error - googleapis types may not be available locally
import { google as rawGoogle } from 'googleapis';

// Minimal local types for the runtime-installed packages (their own types are
// not available locally), describing only what this script uses.
type CoreLike = {
  setFailed: (message: string) => void;
  warning: (message: string) => void;
};

type RepoContext = {
  repo: { owner: string; repo: string };
};

type OctokitLike = {
  graphql: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<GetIssuesWithRcaLabelResponse>;
  rest: {
    issues: {
      removeLabel: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }) => Promise<unknown>;
    };
  };
};

type SheetsV4 = {
  spreadsheets: {
    values: {
      get: (params: { spreadsheetId: string; range: string }) => Promise<{
        data: { values?: string[][] | null };
      }>;
    };
  };
};

type GoogleLike = {
  auth: {
    GoogleAuth: new (options: {
      credentials: unknown;
      scopes: string[];
    }) => unknown;
  };
  sheets: (options: { version: string; auth: unknown }) => SheetsV4;
};

// Shape of the errors we read `message` / `status` from
type ErrorLike = {
  message?: string;
  status?: number;
};

const core = rawCore as CoreLike;
const context = rawContext as RepoContext;
const getOctokit = rawGetOctokit as (token: string) => OctokitLike;
const google = rawGoogle as GoogleLike;

// HTTP status codes enum for better maintainability
enum HttpStatusCode {
  NotFound = 404,
}

type Label = {
  name: string;
  color: string;
  description: string;
};

const RCA_NEEDED_LABEL: Label = {
  name: 'RCA-needed',
  color: 'FF0000',
  description: 'Issue requires Root Cause Analysis',
};

// Google Sheets configuration from environment variables
// @ts-expect-error - process is available at runtime in GitHub Actions
const { SPREADSHEET_ID } = process.env;
// @ts-expect-error - process is available at runtime in GitHub Actions
const { SHEET_NAME } = process.env;

/**
 * Represents a single response row from the RCA (Root Cause Analysis) Google Form.
 * @property issueNumber - The GitHub issue number associated with this RCA response (as a string)
 * @property timestamp - The timestamp when the form was submitted
 * @property [key: string] - Any additional form fields captured from the Google Form.
 *   The keys correspond to column headers in the Google Sheet, and the values are the user responses.
 */
type RcaFormResponse = {
  issueNumber: string;
  timestamp: string;
  [key: string]: unknown;
};

// GitHub GraphQL types
type GitHubLabel = {
  id: string;
  name: string;
};

type GitHubIssue = {
  id: string;
  number: number;
  title: string;
  createdAt: string;
  closedAt: string | null;
  labels: {
    nodes: GitHubLabel[];
  };
};

type GetIssuesWithRcaLabelResponse = {
  repository: {
    issues: {
      nodes: GitHubIssue[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
};

async function main(): Promise<void> {
  try {
    // @ts-expect-error - process is available at runtime in GitHub Actions
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed('GITHUB_TOKEN not found');
      return;
    }

    // Google Sheets API credentials (base64 encoded service account JSON)
    // @ts-expect-error - process is available at runtime in GitHub Actions
    const googleCredentials = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!googleCredentials) {
      core.setFailed('GOOGLE_SHEETS_CREDENTIALS not found');
      return;
    }

    // Validate sheet configuration
    if (!SPREADSHEET_ID) {
      core.setFailed('SPREADSHEET_ID not configured');
      return;
    }
    if (!SHEET_NAME) {
      core.setFailed('SHEET_NAME not configured');
      return;
    }

    // @ts-expect-error - process is available at runtime in GitHub Actions
    const isDryRun = process.env.DRY_RUN === 'true';

    const octokit = getOctokit(githubToken);
    const repoOwner = context.repo.owner;
    const repoName = context.repo.repo;

    console.log(
      `Starting Google Sheets-based RCA label removal (Dry Run: ${isDryRun})`,
    );
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
      repoName,
    );

    console.log(
      `Found ${issuesWithRcaNeeded.length} issues with RCA-needed label`,
    );

    let removedCount = 0;
    let skippedCount = 0;

    let failedCount = 0;
    const failedIssues: number[] = [];

    for (const issue of issuesWithRcaNeeded) {
      console.log(`\n📋 Processing issue #${issue.number}: ${issue.title}`);

      try {
        // Check if issue has RCA response in Google Sheets
        const hasRcaResponse = rcaResponses.some(
          (response) => response.issueNumber === issue.number.toString(),
        );

        if (hasRcaResponse) {
          console.log(
            `✅ RCA response found in Google Sheets for issue #${issue.number}`,
          );

          if (isDryRun) {
            console.log(
              `🔍 [DRY RUN] Would remove label from issue #${issue.number}`,
            );
            removedCount += 1;
          } else {
            // Remove the RCA-needed label
            await removeLabelFromIssue(
              octokit,
              repoOwner,
              repoName,
              issue.number,
              RCA_NEEDED_LABEL.name,
            );

            console.log(
              `✅ Successfully removed RCA-needed label from issue #${issue.number}`,
            );
            removedCount += 1;
          }
        } else {
          console.log(
            `⏳ No RCA found in sheet for issue #${issue.number} - skipping`,
          );
          skippedCount += 1;
        }
      } catch (error: unknown) {
        console.error(
          `❌ Failed to process issue #${issue.number}: ${(error as ErrorLike | undefined)?.message || String(error)}`,
        );
        failedCount += 1;
        failedIssues.push(issue.number);
        // Continue processing other issues
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`  - Repository: ${repoOwner}/${repoName}`);
    console.log(`  - Issues processed: ${issuesWithRcaNeeded.length}`);
    console.log(
      `  - Labels ${isDryRun ? 'would be' : ''} removed: ${removedCount}`,
    );
    console.log(`  - Issues skipped (no RCA in sheet): ${skippedCount}`);

    if (failedCount > 0) {
      console.log(`  - ⚠️  Issues failed: ${failedCount}`);
      console.log(`  - Failed issue numbers: ${failedIssues.join(', ')}`);
      core.warning(`Some issues failed to process: ${failedIssues.join(', ')}`);
    }

    // Set appropriate exit status
    if (failedCount > 0 && removedCount === 0) {
      core.setFailed('All label removal attempts failed');
    } else if (failedCount > 0) {
      console.log(
        `\n⚠️  Completed with ${failedCount} failures. Check logs for details.`,
      );
    } else {
      console.log(`\n✅ All operations completed successfully!`);
    }
  } catch (error: unknown) {
    core.setFailed(
      `Error in Google Sheets RCA label removal: ${(error as ErrorLike | undefined)?.message || String(error)}`,
    );
  }
}

async function initializeGoogleSheets(credentials: string): Promise<SheetsV4> {
  // Decode base64 credentials
  const credentialsJson: unknown = JSON.parse(
    // @ts-expect-error - Buffer is available at runtime in GitHub Actions
    Buffer.from(credentials, 'base64').toString('utf-8'),
  );

  // Initialize Google Sheets API client
  const auth = new google.auth.GoogleAuth({
    credentials: credentialsJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

async function fetchRcaResponses(sheets: SheetsV4): Promise<RcaFormResponse[]> {
  try {
    // Fetch data from the Google Sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`, // Covers columns A through Z
    });

    const rows = response.data.values || [];

    if (rows.length <= 1) {
      // No data rows (only header or empty)
      return [];
    }

    // Dynamically determine the column index for "Issue Number" from the header row
    const headerRow = rows[0] || [];
    const ISSUE_NUMBER_HEADER = 'Issue Number';
    const issueNumberColumnIndex = headerRow.findIndex(
      (col: string) => col?.trim() === ISSUE_NUMBER_HEADER,
    );

    if (issueNumberColumnIndex === -1) {
      throw new Error(
        `Could not find "${ISSUE_NUMBER_HEADER}" column in sheet headers. Please check the Google Sheet structure.`,
      );
    }

    const responses: RcaFormResponse[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      // Skip empty rows
      if (!row || row.length === 0) {
        continue;
      }

      // Get issue number from dynamically determined column
      const issueNumberValue = row[issueNumberColumnIndex];

      if (issueNumberValue !== null && issueNumberValue !== undefined) {
        // Extract just the numeric part from the issue number
        // Handles formats like: "18454", "#18454", or leading/trailing whitespace
        const trimmedValue = issueNumberValue.toString().trim();
        if (!trimmedValue) {
          continue; // Skip if empty string after trimming
        }

        const issueMatch = trimmedValue.match(/^#?(\d+)$/u);
        if (issueMatch) {
          const issueNumber = issueMatch[1];
          responses.push({
            issueNumber,
            timestamp: row[0] || '', // Column A: Timestamp
            // Additional fields can be added if needed:
            // repository: row[2], // Column C: Github Repository
            // issueUrl: row[3],   // Column D: Github Issue URL
          });
          console.log(
            `  Found RCA for issue #${issueNumber} submitted on ${row[0]}`,
          );
        }
      }
    }

    return responses;
  } catch (error: unknown) {
    console.error(
      'Error fetching Google Sheets data:',
      (error as ErrorLike | undefined)?.message || String(error),
    );
    throw error;
  }
}

async function getIssuesWithRcaLabel(
  octokit: OctokitLike,
  owner: string,
  repo: string,
): Promise<GitHubIssue[]> {
  const allIssues: GitHubIssue[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  // Constants for the GraphQL query
  const PAGE_SIZE = 100; // Maximum allowed by GitHub API
  const LABEL_NAMES = [RCA_NEEDED_LABEL.name]; // Use the constant we already have

  while (hasNextPage) {
    const query = `
      query GetIssuesWithRcaLabel(
        $owner: String!,
        $repo: String!,
        $cursor: String,
        $labelNames: [String!],
        $pageSize: Int!
      ) {
        repository(owner: $owner, name: $repo) {
          issues(labels: $labelNames, states: CLOSED, first: $pageSize, after: $cursor) {
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

    const result: GetIssuesWithRcaLabelResponse = await octokit.graphql(query, {
      owner,
      repo,
      cursor,
      labelNames: LABEL_NAMES,
      pageSize: PAGE_SIZE,
    });
    const { issues } = result.repository;

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
  octokit: OctokitLike,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
): Promise<void> {
  try {
    // Use REST API to remove label from issue
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    });
  } catch (error: unknown) {
    // If label doesn't exist on issue, the API will throw 404
    // This is not an error for our use case, so we can safely ignore it
    if ((error as ErrorLike | undefined)?.status !== HttpStatusCode.NotFound) {
      throw error;
    }
  }
}

// Run the main function
main().catch((error: unknown): void => {
  console.error('Unhandled error:', error);
  core.setFailed(
    `Unhandled error: ${(error as ErrorLike | undefined)?.message || String(error)}`,
  );
  // core.setFailed() sets the action's exit code to 1, causing the workflow to fail
});
