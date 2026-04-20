import type { FlakyTestFailure } from '../types';

/**
 * Builds the initial prompt for the agentic analysis loop.
 * Only includes the failure metadata and CI log -- the agent uses tools
 * to fetch source code, knowledge base sections, and past fixes on demand.
 */
export function buildInitialPrompt(
  failure: FlakyTestFailure,
  logSection: string,
  owner: string,
  repo: string,
): string {
  const classification = failure.isFlaky
    ? 'Flaky (passed after retry)'
    : 'Real failure';

  const repoRef = `${owner}/${repo}`;

  return `You are an expert at diagnosing flaky E2E tests in the ${repoRef} repository.

You have tools available to investigate this failure. Use them to:
1. Fetch the test source file and any page objects or helpers it imports (use search_test_file first if you're unsure of the exact path)
2. Look up relevant flakiness patterns from the knowledge base (list categories first, then fetch specific ones)
3. Search for similar past fixes if applicable
4. Fetch CI job logs if you need more context about the failure (use fetch_job_logs with run_id to discover jobs, then fetch specific job logs)

## Failure Information
- Test name: ${failure.name}
- Test file: ${failure.path}
- Error message: ${failure.lastError}
- Times failed: ${failure.realFailures} real failures, ${failure.totalRetries} retries
- Classification: ${classification}
- Run ID: ${failure.runId ?? 'N/A'}
- Job ID: ${failure.jobId ?? 'N/A'}

## Full Error + Stack Trace from CI Logs
\`\`\`
${logSection}
\`\`\`

## Investigation Guidelines
- Most failures in this report are flaky tests, not app bugs
- If the test file path returns "not found", use search_test_file to discover the correct path
- Use list_flakiness_categories and get_flakiness_patterns to learn about known flakiness patterns and anti-patterns for this repository
- Fetch the test source, read its imports, and fetch relevant page objects or helpers
- Search for similar past fixes if applicable

Start by fetching the test file at "${failure.path}". If it's not found, use search_test_file to find the correct path. Then investigate as needed. When done, call submit_analysis with your findings.`;
}
