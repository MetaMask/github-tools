import type { Octokit } from '@octokit/rest';
import type Anthropic from '@anthropic-ai/sdk';
import { fetchFileContent, searchTestFiles } from '../utils/test-source-reader';
import { searchFixesByKeyword } from '../utils/past-fixes-fetcher';
import { fetchJobLogById, listE2eJobs } from '../utils/job-log-fetcher';
import {
  getKnowledgeSection,
  listKnowledgeSections,
} from '../utils/knowledge-base';

export interface ToolContext {
  octokit: Octokit;
  owner: string;
  repo: string;
}

export function getToolDefinitions(
  owner: string,
  repo: string,
): Anthropic.Messages.Tool[] {
  const repoRef = `${owner}/${repo}`;

  return [
    {
      name: 'fetch_file',
      description:
        `Fetch the contents of a file from the ${repoRef} repository. ` +
        'Use this to read test files, page objects, helpers, fixtures, or any source code you need to investigate.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description:
              'File path relative to the repo root, e.g. "test/e2e/tests/connections/edit-account-permissions.spec.ts"',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_test_file',
      description:
        `Search for test files in ${repoRef} by name or keyword. ` +
        'Returns matching file paths under test/e2e/. Use when you do not know the exact path or when fetch_file returns "not found".',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description:
              'Keyword(s) to search for in file paths, e.g. "ens" or "refresh-auth" or "cronjob spec"',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'fetch_job_logs',
      description:
        `Fetch GitHub Actions job logs from ${repoRef}. ` +
        'Provide either a job_id to fetch logs directly, or a run_id to list all e2e jobs in that workflow run. ' +
        'Optionally provide test_name to extract just the relevant failure section from the logs.',
      input_schema: {
        type: 'object' as const,
        properties: {
          job_id: {
            type: 'number',
            description: 'Specific GitHub Actions job ID to fetch logs for',
          },
          run_id: {
            type: 'number',
            description: 'Workflow run ID -- lists all e2e test jobs so you can pick one to fetch logs from',
          },
          test_name: {
            type: 'string',
            description: 'Test name to search for in logs (narrows the log output to the relevant failure)',
          },
        },
      },
    },
    {
      name: 'get_flakiness_patterns',
      description:
        'Get a specific section from the flakiness knowledge base. ' +
        'Each section documents a category of flakiness with real examples and fix PRs. ' +
        'Use a keyword to match a section (e.g. "race conditions", "mocks", "popups", "windows", "re-renders", "assertions", "anti-patterns").',
      input_schema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            description:
              'Keyword to match a knowledge base section, e.g. "race conditions windows", "mocks", "popups modals", "assertions", "anti-patterns"',
          },
        },
        required: ['category'],
      },
    },
    {
      name: 'list_flakiness_categories',
      description:
        'List all available section headings in the flakiness knowledge base. ' +
        'Call this first to discover what categories are available before requesting a specific one.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'search_similar_fixes',
      description:
        `Search for merged pull requests in ${repoRef} that fixed similar flaky test issues. ` +
        'Returns PR titles and diffs filtered to test file changes. Use keywords from the error message or test pattern.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description:
              'Search keyword(s) to find similar past fixes, e.g. "stale element", "waitForSelector", "click intercepted", or the test file name',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'submit_analysis',
      description:
        'Submit the final analysis of the flaky test failure. Call this exactly once when you have completed your investigation.',
      input_schema: {
        type: 'object' as const,
        properties: {
          classification: {
            type: 'string',
            enum: ['flaky_test', 'app_bug', 'infra_issue'],
            description: 'The type of failure',
          },
          confidence: {
            type: 'number',
            description: 'Confidence level 0-100',
          },
          rootCauseCategory: {
            type: 'string',
            enum: [
              'timing',
              'element_state',
              'network_race',
              'stale_reference',
              'state_leakage',
              'animation',
              'missing_mock',
              'unnecessary_steps',
              'window_race',
              'react_rerender',
              'popup_modal',
              'other',
            ],
            description: 'The category of root cause',
          },
          rootCauseExplanation: {
            type: 'string',
            description: '2-3 sentence explanation of what is causing the flakiness',
          },
          specificLines: {
            type: 'array',
            items: { type: 'string' },
            description: 'Line numbers or code snippets causing the issue',
          },
          suggestedFix: {
            type: 'string',
            description: 'Detailed description of the fix with before/after code',
          },
          additionalNotes: {
            type: 'string',
            description: 'Any other observations',
          },
        },
        required: [
          'classification',
          'confidence',
          'rootCauseCategory',
          'rootCauseExplanation',
          'specificLines',
          'suggestedFix',
          'additionalNotes',
        ],
      },
    },
  ];
}

export async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  switch (toolName) {
    case 'fetch_file': {
      const filePath = toolInput.path as string;
      const content = await fetchFileContent(
        context.octokit,
        context.owner,
        context.repo,
        filePath,
      );
      return content ?? `File not found or could not be fetched: ${filePath}`;
    }

    case 'search_test_file': {
      const query = toolInput.query as string;
      const matches = await searchTestFiles(
        context.octokit,
        context.owner,
        context.repo,
        query,
      );
      if (matches.length === 0) {
        return `No test files found matching "${query}". Try broader keywords.`;
      }
      return `Found ${matches.length} matching test file(s):\n${matches.map((p) => `- ${p}`).join('\n')}`;
    }

    case 'fetch_job_logs': {
      const jobId = toolInput.job_id as number | undefined;
      const runId = toolInput.run_id as number | undefined;
      const testName = toolInput.test_name as string | undefined;

      if (jobId) {
        return fetchJobLogById(context.octokit, context.owner, context.repo, jobId, testName);
      }

      if (runId) {
        const jobs = await listE2eJobs(context.octokit, context.owner, context.repo, runId);
        if (jobs.length === 0) {
          return `No e2e test jobs found in run ${runId}.`;
        }
        return (
          `Found ${jobs.length} e2e job(s) in run ${runId}:\n` +
          jobs.map((j) => `- Job ${j.id}: ${j.name} (conclusion: ${j.conclusion ?? 'running'})`).join('\n') +
          '\n\nCall fetch_job_logs again with a specific job_id to get logs.'
        );
      }

      return 'Provide either job_id or run_id.';
    }

    case 'get_flakiness_patterns': {
      const category = toolInput.category as string;
      return getKnowledgeSection(category);
    }

    case 'list_flakiness_categories': {
      const sections = listKnowledgeSections();
      return `Available knowledge base sections:\n${sections.map((s) => `- ${s}`).join('\n')}`;
    }

    case 'search_similar_fixes': {
      const query = toolInput.query as string;
      const fixes = await searchFixesByKeyword(
        context.octokit,
        context.owner,
        context.repo,
        query,
      );
      if (fixes.length === 0) {
        return `No merged flaky test fix PRs found matching "${query}".`;
      }
      return fixes
        .map(
          (fix) =>
            `### PR #${fix.prNumber}: ${fix.title}\n\`\`\`diff\n${fix.diffContent}\n\`\`\``,
        )
        .join('\n\n');
    }

    case 'submit_analysis': {
      return JSON.stringify(toolInput);
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
