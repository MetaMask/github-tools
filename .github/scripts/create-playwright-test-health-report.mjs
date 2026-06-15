#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import { downloadArtifactZip, findFilesInZip } from './lib/artifact-download.mjs';
import { parsePlaywrightJsonReport } from './lib/parse-playwright-json.mjs';
import { sendSlackBatched, truncateError } from './lib/slack-test-health-blocks.mjs';
import { summarizeTestHealth } from './lib/summarize-test-health.mjs';
import { getDateRange, getWorkflowRuns } from './lib/workflow-runs.mjs';

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  throw new Error('Missing GITHUB_TOKEN env var');
}

const env = {
  OWNER: process.env.OWNER || 'MetaMask',
  REPOSITORY: process.env.REPOSITORY,
  WORKFLOW_IDS: process.env.WORKFLOW_IDS,
  BRANCH: process.env.BRANCH || 'main',
  LOOKBACK_DAYS: parseInt(process.env.LOOKBACK_DAYS ?? '1'),
  ARTIFACT_NAME_PREFIX: process.env.ARTIFACT_NAME_PREFIX || 'playwright-json-report',
  RESULTS_FILE_PATTERN: process.env.RESULTS_FILE_PATTERN || 'playwright-report',
  TOP_N: parseInt(process.env.TOP_N ?? '10'),
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

function createSlackBlocks(summary, dateDisplay, metadata) {
  const topItems = summary.slice(0, env.TOP_N);
  const broken = topItems.filter(item => item.brokenCount > 0);
  const flaky = topItems.filter(item => item.brokenCount === 0 && item.flakyCount > 0);

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${env.REPORT_TITLE} — Top ${env.TOP_N}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Period (UTC): ${dateDisplay} | Repo: ${env.REPOSITORY} | Workflows: ${metadata.workflowsScanned.join(', ')} | Failed CI Runs: ${metadata.failedRunCount}/${metadata.workflowCount} from ${env.BRANCH}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (topItems.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No flaky or broken tests found ✅',
      },
    });
    return blocks;
  }

  if (broken.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*❌ Broken (failed all retries)*' },
    });

    broken.forEach((test, index) => {
      const fileUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/blob/${env.BRANCH}/${test.path}`;
      const runUrl = test.lastBrokenRunUrl || `https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.lastBrokenRunId}`;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${index + 1}. <${fileUrl}|${test.name}> *(${test.projectName})* — broken: *${test.brokenCount}*, flaky: *${test.flakyCount}*, retries: *${test.totalRetries}*${runUrl ? ` | <${runUrl}|run log>` : ''}`,
        },
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_${truncateError(test.lastBrokenError)}_` },
      });
    });
  }

  if (broken.length > 0 && flaky.length > 0) {
    blocks.push({ type: 'divider' });
  }

  if (flaky.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🟡 Flaky (passed on retry)*' },
    });

    flaky.forEach((test, index) => {
      const fileUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/blob/${env.BRANCH}/${test.path}`;
      const runUrl = test.lastFlakyRunUrl || `https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.lastFlakyRunId}`;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${index + 1}. <${fileUrl}|${test.name}> *(${test.projectName})* — flaky: *${test.flakyCount}*, retries: *${test.totalRetries}*${runUrl ? ` | <${runUrl}|run log>` : ''}`,
        },
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_${truncateError(test.lastFlakyError)}_` },
      });
    });
  }

  return blocks;
}

async function sendSlackReport(summary, dateDisplay, metadata) {
  if (!env.SLACK_WEBHOOK || !env.SLACK_WEBHOOK.startsWith('https://')) {
    console.log('Skipping Slack notification');
    return;
  }

  const blocks = createSlackBlocks(summary, dateDisplay, metadata);
  await sendSlackBatched(env.SLACK_WEBHOOK, blocks);
  console.log('✅ Report sent to Slack successfully');
}

async function main() {
  const github = new Octokit({ auth: env.GITHUB_TOKEN });
  const dateRange = getDateRange(env.LOOKBACK_DAYS);
  const workflowsScanned = getWorkflowIds();

  console.log('🧪 Playwright Test Health Report\n');
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

    const summary = summarizeTestHealth(findings);
    await sendSlackReport(summary, dateRange.display, {
      workflowCount: workflowRuns.length,
      failedRunCount,
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
