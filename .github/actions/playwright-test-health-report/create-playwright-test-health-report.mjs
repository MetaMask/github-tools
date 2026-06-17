#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import { downloadArtifactZip, findFilesInZip } from './lib/artifact-download.mjs';
import { parsePlaywrightJsonReport } from './lib/parse-playwright-json.mjs';
import { createSlackBlocks, sendSlackBatched } from './lib/slack-test-health-blocks.mjs';
import { partitionSummary } from './lib/classify-report-buckets.mjs';
import { summarizeTestHealth } from './lib/summarize-test-health.mjs';
import { getDateRange, getWorkflowRuns } from './lib/workflow-runs.mjs';

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  throw new Error('Missing GITHUB_TOKEN env var');
}

const parsePositiveInt = (value, fallback) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const env = {
  OWNER: process.env.OWNER || 'MetaMask',
  REPOSITORY: process.env.REPOSITORY,
  WORKFLOW_IDS: process.env.WORKFLOW_IDS,
  BRANCH: process.env.BRANCH || 'main',
  LOOKBACK_DAYS: parsePositiveInt(process.env.LOOKBACK_DAYS, 1),
  ARTIFACT_NAME_PREFIX: process.env.ARTIFACT_NAME_PREFIX || 'playwright-json-report',
  RESULTS_FILE_PATTERN: process.env.RESULTS_FILE_PATTERN || 'playwright-report',
  TOP_N: parsePositiveInt(process.env.TOP_N, 15),
  REPORT_TITLE: process.env.REPORT_TITLE || 'Playwright Test Health Report',
  SLACK_WEBHOOK: process.env.SLACK_WEBHOOK || '',
  GITHUB_TOKEN: githubToken,
};

if (!env.REPOSITORY) {
  throw new Error('Missing REPOSITORY env var');
}
if (!env.WORKFLOW_IDS) {
  throw new Error('Missing WORKFLOW_IDS env var');
}

function getWorkflowIds() {
  return env.WORKFLOW_IDS.split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isTestFailureFinding(finding) {
  return finding.classification === 'broken' || finding.classification === 'flaky' || finding.classification === 'infra';
}

function countTestFailureRuns(findings) {
  return new Set(findings.filter(isTestFailureFinding).map(finding => finding.runId)).size;
}

async function getMergedWorkflowRuns(github, dateRange) {
  const workflowIds = getWorkflowIds();
  const runs = [];

  for (const workflowId of workflowIds) {
    const workflowRuns = await getWorkflowRuns(github, {
      owner: env.OWNER,
      repo: env.REPOSITORY,
      workflowId,
      branch: env.BRANCH,
      from: dateRange.from,
      to: dateRange.to,
    });
    runs.push(...workflowRuns);
  }

  const dedupedRuns = Array.from(new Map(runs.map(run => [run.id, run])).values());
  dedupedRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return dedupedRuns;
}

async function collectFindings(github, runs) {
  const findings = [];
  let matchingArtifacts = 0;

  for (const [index, run] of runs.entries()) {
    console.log(`📦 Processing run ${index + 1}/${runs.length}: ${run.id}`);

    const artifacts = await github.paginate(
      github.rest.actions.listWorkflowRunArtifacts,
      {
        owner: env.OWNER,
        repo: env.REPOSITORY,
        run_id: run.id,
      },
    );

    const matching = artifacts.filter(artifact => artifact.name.startsWith(env.ARTIFACT_NAME_PREFIX));
    matchingArtifacts += matching.length;

    if (matching.length === 0) {
      console.log(`  ⚠️  No matching artifacts found for run ${run.id}`);
      continue;
    }

    for (const artifact of matching) {
      try {
        const zip = await downloadArtifactZip(github, {
          owner: env.OWNER,
          repo: env.REPOSITORY,
          artifactId: artifact.id,
        });
        const jsonFiles = findFilesInZip(zip, env.RESULTS_FILE_PATTERN);

        if (jsonFiles.length === 0) {
          console.log(`  ⚠️  No ${env.RESULTS_FILE_PATTERN} file found in ${artifact.name}`);
          continue;
        }

        for (const file of jsonFiles) {
          try {
            const content = await file.buffer();
            const report = JSON.parse(content.toString());
            findings.push(
              ...parsePlaywrightJsonReport(report, {
                runId: run.id,
                runUrl: run.html_url || `https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${run.id}`,
                date: run.created_at,
                artifactName: artifact.name,
              }),
            );
          } catch (error) {
            console.log(`  ❌ Invalid JSON in ${artifact.name}/${file.path}: ${error.message}`);
          }
        }
      } catch (error) {
        console.log(`  ❌ Failed to process artifact ${artifact.name}: ${error.message}`);
      }
    }
  }

  return { findings, matchingArtifacts };
}

async function sendSlackReport(summary, dateDisplay, metadata) {
  if (!env.SLACK_WEBHOOK || !env.SLACK_WEBHOOK.startsWith('https://')) {
    console.log('Skipping Slack notification');
    return;
  }

  const blocks = createSlackBlocks(summary, dateDisplay, {
    owner: env.OWNER,
    repository: env.REPOSITORY,
    branch: env.BRANCH,
    reportTitle: env.REPORT_TITLE,
    topN: env.TOP_N,
    workflowsScanned: metadata.workflowsScanned,
    workflowCount: metadata.workflowCount,
    testFailureRunCount: metadata.testFailureRunCount,
    otherFailedRunCount: metadata.otherFailedRunCount,
    lookbackDays: env.LOOKBACK_DAYS,
  });
  await sendSlackBatched(env.SLACK_WEBHOOK, blocks);
  console.log('✅ Report sent to Slack successfully');
}

function logClassificationDiagnostics(summary, metadata) {
  const { brokenItems, flakyItems, watchItems, infraItems } = partitionSummary(summary);

  console.log('\n🧾 Classification diagnostics');
  console.log(`  Lookback: ${env.LOOKBACK_DAYS} day(s)`);
  console.log(`  Unique tests observed: ${summary.length}`);
  console.log(
    `  Buckets -> broken: ${brokenItems.length}, flaky: ${flakyItems.length}, watch: ${watchItems.length}, infra: ${infraItems.length}`,
  );
  console.log(`  CI runs: ${metadata.workflowCount} | Test-failure runs: ${metadata.testFailureRunCount}`);
  console.log(`  Other CI failures: ${metadata.otherFailedRunCount}`);

  if (watchItems.length > 0) {
    const preview = watchItems
      .slice(0, 5)
      .map(test => {
        const broken = test.historicalBrokenCount ?? 0;
        const flaky = test.historicalFlakyCount ?? 0;
        return `${test.name} (${test.projectName}, broken ${broken}, flaky ${flaky})`;
      })
      .join('; ');
    console.log(`  Sample watch: ${preview}`);
  }
}

async function main() {
  const github = new Octokit({ auth: env.GITHUB_TOKEN });
  const dateRange = getDateRange(env.LOOKBACK_DAYS);
  const workflowsScanned = getWorkflowIds();

  console.log('🧪 Playwright Test Health Report\n');
  console.log(`Lookback: ${env.LOOKBACK_DAYS} day(s)`);
  console.log(`Time range: ${dateRange.from} to ${dateRange.to}`);
  console.log(`Workflows: ${workflowsScanned.join(', ')}\n`);

  try {
    const workflowRuns = await getMergedWorkflowRuns(github, dateRange);

    if (workflowRuns.length === 0) {
      console.log('⚠️ No workflow runs found in lookback window.');
      return;
    }

    const failedRunCount = workflowRuns.filter(run => run.conclusion === 'failure').length;
    const { findings, matchingArtifacts } = await collectFindings(github, workflowRuns);

    if (matchingArtifacts === 0) {
      console.log('⚠️ No matching artifacts found.');
      return;
    }

    const testFailureRunCount = countTestFailureRuns(findings);
    const otherFailedRunCount = Math.max(0, failedRunCount - testFailureRunCount);
    const summary = summarizeTestHealth(findings);

    logClassificationDiagnostics(summary, {
      workflowCount: workflowRuns.length,
      testFailureRunCount,
      otherFailedRunCount,
    });

    await sendSlackReport(summary, dateRange.display, {
      workflowCount: workflowRuns.length,
      testFailureRunCount,
      otherFailedRunCount,
      workflowsScanned,
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.status === 401) {
      console.log('\n💡 GitHub token is unauthorized. Ensure it has repo and actions:read permissions.');
    }
    if (error.status === 404) {
      console.log('\n💡 One or more workflows were not found. Check WORKFLOW_IDS values.');
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n❌ Unexpected error:', error);
  process.exit(1);
});
