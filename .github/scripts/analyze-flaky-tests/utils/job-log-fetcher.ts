import type { Octokit } from '@octokit/rest';
import type { FlakyTestFailure } from '../types';

const CONTEXT_LINES = 100;

const ERROR_PATTERNS = [
  /Error:/i,
  /AssertionError:/i,
  /TimeoutError:/i,
  /AssertionError/i,
  /at\s+.*\.(spec|test)\.(ts|js)/,
];

function extractRelevantLogSection(
  logText: string,
  testName: string,
): string {
  const lines = logText.split('\n');

  const testNameIndex = lines.findIndex((line) => line.includes(testName));

  let errorIndex = -1;
  if (testNameIndex !== -1) {
    for (let i = testNameIndex; i < Math.min(testNameIndex + 50, lines.length); i++) {
      if (ERROR_PATTERNS.some((pattern) => pattern.test(lines[i] ?? ''))) {
        errorIndex = i;
        break;
      }
    }
  }

  const anchorIndex = errorIndex !== -1 ? errorIndex : testNameIndex;

  if (anchorIndex === -1) {
    let lastErrorIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (ERROR_PATTERNS.some((pattern) => pattern.test(lines[i] ?? ''))) {
        lastErrorIndex = i;
        break;
      }
    }
    if (lastErrorIndex !== -1) {
      const start = Math.max(0, lastErrorIndex - CONTEXT_LINES);
      const end = Math.min(lines.length, lastErrorIndex + CONTEXT_LINES);
      return lines.slice(start, end).join('\n');
    }
    return lines.slice(-200).join('\n');
  }

  const start = Math.max(0, anchorIndex - CONTEXT_LINES);
  const end = Math.min(lines.length, anchorIndex + CONTEXT_LINES);
  return lines.slice(start, end).join('\n');
}

export async function fetchJobLog(
  octokit: Octokit,
  failure: FlakyTestFailure,
  owner: string,
  repo: string,
): Promise<string> {
  if (!failure.jobId) {
    return 'No job ID available for this failure.';
  }

  return fetchJobLogById(octokit, owner, repo, failure.jobId, failure.name);
}

export async function fetchJobLogById(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobId: number,
  testName?: string,
): Promise<string> {
  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });

    const logText = typeof response.data === 'string'
      ? response.data
      : String(response.data);

    if (testName) {
      return extractRelevantLogSection(logText, testName);
    }
    if (logText.length > 30000) {
      return `${logText.substring(0, 30000)}\n... (truncated, ${logText.length} chars total)`;
    }
    return logText;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch job log for job ${jobId}: ${message}`);
    return `Failed to fetch job log: ${message}`;
  }
}

export interface E2eJobInfo {
  id: number;
  name: string;
  conclusion: string | null;
  htmlUrl: string;
}

export async function listE2eJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<E2eJobInfo[]> {
  const jobs: E2eJobInfo[] = [];

  for (let page = 1; page <= 5; page++) {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      per_page: 100,
      page,
    });

    for (const job of data.jobs) {
      const nameLower = job.name.toLowerCase();
      if (nameLower.includes('e2e')) {
        jobs.push({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion ?? null,
          htmlUrl: job.html_url ?? '',
        });
      }
    }

    if (data.jobs.length < 100) break;
  }

  return jobs;
}
