import fs from 'fs';
import { Octokit } from '@octokit/rest';
import type { AnalysisResult, FlakyTestFailure, SlackFinding } from './types';
import { fetchJobLog } from './utils/job-log-fetcher';
import { postSlackFindings } from './utils/slack-reporter';
import { buildInitialPrompt } from './llm/prompt-builder';
import { analyzeWithClaude } from './llm/claude-analyzer';
import { executeToolCall } from './llm/tools';
import type { ToolContext } from './llm/tools';
import {
  getKnowledgeSection,
  listKnowledgeSections,
} from './utils/knowledge-base';

interface Config {
  githubToken: string;
  claudeApiKey: string;
  slackBotToken: string;
  slackChannelId: string;
  slackThreadTs: string;
  targetOwner: string;
  targetRepo: string;
  failuresJson: string;
  dryRun: boolean;
}

function loadConfig(): Config {
  const mockLlm = process.argv.includes('--mock-llm');
  const requiredVars = mockLlm ? ['GITHUB_TOKEN'] : ['GITHUB_TOKEN', 'E2E_CLAUDE_API_KEY'];

  for (const envVar of requiredVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  const dryRun = process.argv.includes('--dry-run');

  return {
    githubToken: process.env.GITHUB_TOKEN!,
    claudeApiKey: process.env.E2E_CLAUDE_API_KEY ?? 'mock',
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
    slackChannelId: process.env.SLACK_CHANNEL_ID ?? '',
    slackThreadTs: process.env.SLACK_THREAD_TS ?? '',
    targetOwner: process.env.TARGET_OWNER ?? 'MetaMask',
    targetRepo: process.env.TARGET_REPO ?? 'metamask-extension',
    failuresJson: process.env.FAILURES_JSON ?? '',
    dryRun,
  };
}

function parseFailures(failuresJson: string): FlakyTestFailure[] {
  if (!failuresJson) {
    throw new Error(
      'FAILURES_JSON is empty. Pass it as an env var or use --fixtures-file <path>.',
    );
  }
  return JSON.parse(failuresJson) as FlakyTestFailure[];
}

function loadFailuresFromArgs(): string {
  const fixturesIdx = process.argv.indexOf('--fixtures-file');
  if (fixturesIdx !== -1 && process.argv[fixturesIdx + 1]) {
    const filePath = process.argv[fixturesIdx + 1]!;
    console.log(`Loading failures from file: ${filePath}\n`);
    return fs.readFileSync(filePath, 'utf-8');
  }
  return process.env.FAILURES_JSON ?? '';
}

async function mockAnalysis(
  failure: FlakyTestFailure,
  logSection: string,
  toolContext: ToolContext,
): Promise<AnalysisResult> {
  console.log('  [mock-llm] Simulating tool calls that Claude would make...');

  // 1. Try fetching the test file
  console.log(`    [tool] fetch_file({"path":"${failure.path}"})`);
  const testContent = await executeToolCall('fetch_file', { path: failure.path }, toolContext);
  let resolvedPath = failure.path;
  let fetched: string;

  if (testContent.startsWith('File not found')) {
    console.log('    [tool] fetch_file => NOT FOUND');

    // 2. Search for the correct file path
    const testNameKeyword = failure.name.split(' ')[0]!.toLowerCase();
    console.log(`    [tool] search_test_file({"query":"${testNameKeyword}"})`);
    const searchResult = await executeToolCall('search_test_file', { query: testNameKeyword }, toolContext);
    console.log(`    [tool] search_test_file => ${searchResult.split('\n').length - 1} results`);

    const firstMatch = searchResult.match(/^- (.+\.spec\.\w+)$/m);
    if (firstMatch?.[1]) {
      resolvedPath = firstMatch[1];
      console.log(`    [tool] fetch_file({"path":"${resolvedPath}"})`);
      const retryContent = await executeToolCall('fetch_file', { path: resolvedPath }, toolContext);
      fetched = retryContent.startsWith('File not found') ? 'NOT FOUND' : `${retryContent.length} chars`;
      console.log(`    [tool] fetch_file => ${fetched}`);
    } else {
      fetched = 'NOT FOUND (search also returned no .spec files)';
    }
  } else {
    fetched = `${testContent.length} chars`;
    console.log(`    [tool] fetch_file => ${fetched}`);
  }

  // 3. Try fetching job logs via runId
  if (failure.runId) {
    console.log(`    [tool] fetch_job_logs({"run_id":${failure.runId}})`);
    const jobsResult = await executeToolCall('fetch_job_logs', { run_id: failure.runId }, toolContext);
    const jobCount = (jobsResult.match(/^- Job /gm) ?? []).length;
    console.log(`    [tool] fetch_job_logs => ${jobCount} e2e jobs found`);
  }

  // 4. Knowledge base lookup
  console.log('    [tool] list_flakiness_categories({})');
  const categories = listKnowledgeSections();
  console.log(`    [tool] list_flakiness_categories => ${categories.length} sections`);

  const errorLower = failure.lastError.toLowerCase();
  let matchedCategory = 'other';
  if (errorLower.includes('stale')) matchedCategory = 'stale_reference';
  else if (errorLower.includes('timeout')) matchedCategory = 'timing';
  else if (errorLower.includes('click intercepted')) matchedCategory = 'element_state';
  else if (errorLower.includes('no such window')) matchedCategory = 'window_race';

  const knowledgeQuery = matchedCategory === 'stale_reference' ? 'React Re-renders'
    : matchedCategory === 'timing' ? 'Actions that Take Time'
    : matchedCategory === 'window_race' ? 'Race Conditions with Windows'
    : 'Anti-Patterns';

  console.log(`    [tool] get_flakiness_patterns({"category":"${knowledgeQuery}"})`);
  const section = getKnowledgeSection(knowledgeQuery);
  console.log(`    [tool] get_flakiness_patterns => ${section.length} chars`);

  // 5. Search for similar fixes
  const fixKeyword = failure.name.split(' ').slice(0, 3).join(' ');
  console.log(`    [tool] search_similar_fixes({"query":"${fixKeyword}"})`);
  const fixes = await executeToolCall(
    'search_similar_fixes',
    { query: fixKeyword },
    toolContext,
  );
  console.log(`    [tool] search_similar_fixes => ${fixes.length} chars`);

  console.log('    [tool] submit_analysis({...})');

  return {
    testName: failure.name,
    testPath: resolvedPath,
    classification: 'flaky_test',
    confidence: 75,
    rootCauseCategory: matchedCategory,
    rootCauseExplanation: `[MOCK] Based on error "${failure.lastError.substring(0, 80)}...", this appears to be a ${matchedCategory} issue. The test file was ${fetched}. Found ${categories.length} knowledge base sections and ${fixes.length} chars of similar fix data.`,
    specificLines: ['[MOCK] Line analysis requires real Claude API'],
    suggestedFix: '[MOCK] Fix suggestion requires real Claude API. Run without --mock-llm to get actual analysis.',
    additionalNotes: `[MOCK] CI log section: ${logSection.substring(0, 100)}...`,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const octokit = new Octokit({ auth: config.githubToken });
  const mockLlm = process.argv.includes('--mock-llm');

  console.log('=== Flaky Test AI Analyzer (Tool-Augmented Agent) ===\n');

  if (mockLlm) {
    console.log('MOCK LLM MODE: Using mock Claude responses. Tools will execute for real.\n');
  }
  if (config.dryRun) {
    console.log('DRY RUN MODE: Results will be printed to stdout, not posted to Slack.\n');
  }

  const failuresSource = loadFailuresFromArgs() || config.failuresJson;
  const failures = parseFailures(failuresSource);
  console.log(`Analyzing ${failures.length} test failures...\n`);

  const toolContext: ToolContext = {
    octokit,
    owner: config.targetOwner,
    repo: config.targetRepo,
  };

  const findings: SlackFinding[] = [];

  for (let i = 0; i < failures.length; i++) {
    const failure = failures[i]!;
    console.log(
      `[${i + 1}/${failures.length}] Analyzing: ${failure.name}`,
    );

    try {
      console.log('  Fetching job log...');
      const logSection = await fetchJobLog(
        octokit,
        failure,
        config.targetOwner,
        config.targetRepo,
      );

      let analysis: AnalysisResult;
      if (mockLlm) {
        analysis = await mockAnalysis(failure, logSection, toolContext);
      } else {
        console.log('  Starting agentic analysis with Claude...');
        const prompt = buildInitialPrompt(failure, logSection, config.targetOwner, config.targetRepo);
        analysis = await analyzeWithClaude(
          prompt,
          failure,
          config.claudeApiKey,
          toolContext,
        );
      }

      const jobUrl = failure.jobId && failure.runId
        ? `https://github.com/${config.targetOwner}/${config.targetRepo}/actions/runs/${failure.runId}/job/${failure.jobId}`
        : '';
      const fileUrl = `https://github.com/${config.targetOwner}/${config.targetRepo}/blob/main/${failure.path}`;

      findings.push({ failure, analysis, jobUrl, fileUrl });

      console.log(`  Result: ${analysis.classification} (${analysis.confidence}% confidence)`);
      console.log(`  Root cause: ${analysis.rootCauseCategory}\n`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to analyze: ${message}\n`);
    }
  }

  console.log(`\n=== Analysis complete: ${findings.length}/${failures.length} tests analyzed ===\n`);

  if (config.dryRun) {
    for (const finding of findings) {
      console.log('---');
      console.log(`Test: ${finding.failure.name}`);
      console.log(`File: ${finding.failure.path}`);
      console.log(`Classification: ${finding.analysis.classification}`);
      console.log(`Confidence: ${finding.analysis.confidence}%`);
      console.log(`Root Cause: ${finding.analysis.rootCauseCategory}`);
      console.log(`Explanation: ${finding.analysis.rootCauseExplanation}`);
      if (finding.analysis.specificLines.length > 0) {
        console.log(`Problematic Lines:\n  ${finding.analysis.specificLines.join('\n  ')}`);
      }
      console.log(`Suggested Fix: ${finding.analysis.suggestedFix}`);
      if (finding.analysis.additionalNotes) {
        console.log(`Notes: ${finding.analysis.additionalNotes}`);
      }
      console.log(`Job: ${finding.jobUrl}`);
      console.log(`File: ${finding.fileUrl}`);
      console.log('');
    }
    return;
  }

  if (!config.slackBotToken || !config.slackChannelId || !config.slackThreadTs) {
    console.log(
      'Slack credentials or thread_ts not provided. Skipping Slack posting.',
    );
    console.log('Set SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, and SLACK_THREAD_TS to enable.');
    return;
  }

  console.log('Posting findings to Slack thread...');
  await postSlackFindings(
    findings,
    config.slackThreadTs,
    config.slackBotToken,
    config.slackChannelId,
  );
  console.log('Done!');
}

main().catch((error: unknown) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
