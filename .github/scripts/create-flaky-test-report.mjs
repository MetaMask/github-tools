#!/usr/bin/env node

// Based on the original script done by @itsyoboieltr on Extension repo

import { Octokit } from '@octokit/rest';
import { downloadArtifactZip, findFilesInZip } from './lib/artifact-download.mjs';
import { sendSlackBatched, truncateError } from './lib/slack-test-health-blocks.mjs';
import { getDateRange, getWorkflowRuns } from './lib/workflow-runs.mjs';

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) throw new Error('Missing GITHUB_TOKEN env var');

const env = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  LOOKBACK_DAYS: parseInt(process.env.LOOKBACK_DAYS ?? '1'),
  TEST_RESULTS_FILE_PATTERN: process.env.TEST_RESULTS_FILE_PATTERN || 'test-runs',
  OWNER: process.env.OWNER || 'MetaMask',
  REPOSITORY: process.env.REPOSITORY || 'metamask-mobile',
  WORKFLOW_ID: process.env.WORKFLOW_ID || 'ci.yml',
  BRANCH: process.env.BRANCH || 'main',
  SLACK_WEBHOOK_FLAKY_TESTS: process.env.SLACK_WEBHOOK_FLAKY_TESTS || '',
  TEST_REPORT_ARTIFACTS: process.env.TEST_REPORT_ARTIFACTS
    ? process.env.TEST_REPORT_ARTIFACTS.split(',').map(name => name.trim())
    : ['test-e2e-android-json-report', 'test-e2e-ios-json-report', 'test-e2e-chrome-report', 'test-e2e-firefox-report'],
};

async function downloadTestArtifacts(github, runs) {
  const allTestData = [];

  for (const [index, run] of runs.entries()) {
    console.log(`📦 Processing run ${index + 1}/${runs.length}: ${run.head_commit?.message?.split('\n')[0] || 'No commit message'}`);

    try {
      const artifacts = await github.paginate(
        github.rest.actions.listWorkflowRunArtifacts,
        {
          owner: env.OWNER,
          repo: env.REPOSITORY,
          run_id: run.id,
        }
      );

      const testArtifacts = artifacts.filter(artifact =>
        env.TEST_REPORT_ARTIFACTS.includes(artifact.name)
      );

      if (testArtifacts.length === 0) {
        console.log(`  ⚠️  No test artifacts found for run ${run.id}`);
        continue;
      }

      for (const artifact of testArtifacts) {
        try {
          const zip = await downloadArtifactZip(github, {
            owner: env.OWNER,
            repo: env.REPOSITORY,
            artifactId: artifact.id,
          });
          const testFiles = findFilesInZip(zip, env.TEST_RESULTS_FILE_PATTERN);
          const testFile = testFiles[0];
          if (!testFile) {
            console.log(`  ⚠️  No ${env.TEST_RESULTS_FILE_PATTERN} file found in ${artifact.name}`);
            continue;
          }

          const content = await testFile.buffer();
          const testData = JSON.parse(content.toString());
          console.log(`   Parsed ${artifact.name} (${testData.length} top testSuites)`);
          allTestData.push(...testData);
        } catch (error) {
          console.log(`  ❌ Failed to download ${artifact.name}: ${error.message}`);
        }
      }
    } catch (error) {
      console.log(`  ❌ Failed to process run ${run.id}: ${error.message}`);
    }
  }

  return allTestData;
}


function extractRealFailures(testData) {
  const realFailures = [];

  for (const testRun of testData) {
    for (const testFile of testRun.testFiles || []) {
      for (const testSuite of testFile.testSuites || []) {
        const retryCount = testSuite.attempts ? testSuite.attempts.length : 0;

        // Process tests that failed even after retries
        for (const testCase of testSuite.testCases || []) {
          if (testCase.status === 'failed') {
            realFailures.push({
              name: testCase.name,
              path: testFile.path,
              error: testCase.error || 'No error details',
              time: testCase.time || 0,
              suite: testSuite.name,
              jobId: testSuite.job?.id,
              runId: testSuite.job?.runId,
              date: new Date(testSuite.date || Date.now()),
              retryCount: retryCount,
              type: 'real_failure'
            });
          }
        }
      }
    }
  }

  return realFailures;
}

function extractFlakyTests(testData) {
  const flakyTests = [];

  for (const testRun of testData) {
    for (const testFile of testRun.testFiles || []) {
      for (const testSuite of testFile.testSuites || []) {
        const retryCount = testSuite.attempts ? testSuite.attempts.length : 0;

        // Only process suites that have attempts (retries)
        if (retryCount > 0) {
          // Track failed tests in attempts
          const failedInAttempts = new Map();
          for (const attempt of testSuite.attempts || []) {
            for (const testCase of attempt.testCases || []) {
              if (testCase.status === 'failed') {
                failedInAttempts.set(testCase.name, {
                  jobId: attempt.job?.id,
                  runId: attempt.job?.runId,
                  error: testCase.error || 'No error details',
                  date: new Date(attempt.date || Date.now())
                });
              }
            }
          }

          // Process tests that eventually passed but had initial failures
          for (const testCase of testSuite.testCases || []) {
            if (testCase.status === 'passed' && failedInAttempts.has(testCase.name)) {
              const failureInfo = failedInAttempts.get(testCase.name);
              flakyTests.push({
                name: testCase.name,
                path: testFile.path,
                error: failureInfo.error,
                time: testCase.time || 0,
                suite: testSuite.name,
                jobId: failureInfo.jobId,
                runId: failureInfo.runId,
                date: failureInfo.date,
                retryCount: retryCount,
                type: 'flaky'
              });
            }
          }
        }
      }
    }
  }

  return flakyTests;
}


function summarizeFailures(realFailures, flakyTests = []) {
  const summary = new Map();

  // Process real failures first
  for (const test of realFailures) {
    if (summary.has(test.name)) {
      const existing = summary.get(test.name);
      existing.realFailures += 1;
      existing.totalRetries += test.retryCount;
      // Update to chronologically latest real failure
      if (test.date > existing.lastRealFailureDate) {
        existing.lastRealFailureJobId = test.jobId;
        existing.lastRealFailureRunId = test.runId;
        existing.lastRealFailureError = test.error;
        existing.lastRealFailureDate = test.date;
      }
      // Update last seen
      if (test.date > existing.lastSeen) {
        existing.lastSeen = test.date;
      }
    } else {
      summary.set(test.name, {
        name: test.name,
        path: test.path,
        realFailures: 1,
        totalRetries: test.retryCount,
        lastSeen: test.date,
        suite: test.suite,
        lastRealFailureJobId: test.jobId,
        lastRealFailureRunId: test.runId,
        lastRealFailureError: test.error,
        lastRealFailureDate: test.date,
        // Initialize flaky info as null
        flakyFailureJobId: null,
        flakyFailureRunId: null,
        flakyFailureError: null,
        flakyFailureDate: null
      });
    }
  }

  // Process flaky tests second
  for (const test of flakyTests) {
    if (summary.has(test.name)) {
      // This test also had real failures - just add flaky info
      const existing = summary.get(test.name);
      existing.totalRetries += test.retryCount;
      // Keep most recent flaky failure info
      if (!existing.flakyFailureJobId || test.date > existing.flakyFailureDate) {
        existing.flakyFailureJobId = test.jobId;
        existing.flakyFailureRunId = test.runId;
        existing.flakyFailureError = test.error;
        existing.flakyFailureDate = test.date;
      }
      // Update last seen
      if (test.date > existing.lastSeen) {
        existing.lastSeen = test.date;
      }
    } else {
      // This is purely a flaky test (no real failures)
      summary.set(test.name, {
        name: test.name,
        path: test.path,
        realFailures: 0,
        totalRetries: test.retryCount,
        lastSeen: test.date,
        suite: test.suite,
        // No real failure info
        lastRealFailureJobId: null,
        lastRealFailureRunId: null,
        lastRealFailureError: null,
        lastRealFailureDate: null,
        // Flaky failure info
        flakyFailureJobId: test.jobId,
        flakyFailureRunId: test.runId,
        flakyFailureError: test.error,
        flakyFailureDate: test.date
      });
    }
  }

  return Array.from(summary.values())
    .sort((a, b) => {
      // Real failures first, sorted by failure count
      if (a.realFailures !== b.realFailures) {
        return b.realFailures - a.realFailures;
      }
      // If both have same real failure count, sort by total retries
      return b.totalRetries - a.totalRetries;
    });
}

async function sendSlackReport(summary, dateDisplay, workflowCount, failedCount) {
  if (!env.SLACK_WEBHOOK_FLAKY_TESTS || !env.SLACK_WEBHOOK_FLAKY_TESTS.startsWith('https://')) {
    console.log('Skipping Slack notification');
    return;
  }

  console.log('\n📤 Sending report to Slack...');
  try {
    const blocks = createSlackBlocks(summary, dateDisplay, workflowCount, failedCount);
    await sendSlackBatched(env.SLACK_WEBHOOK_FLAKY_TESTS, blocks);

    console.log('✅ Report sent to Slack successfully');
  } catch (slackError) {
    console.error('❌ Failed to send Slack notification:', slackError.message);
  }
}

function createSlackBlocks(summary, dateDisplay, workflowCount = 0, failedCount = 0) {
  const blocks = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: 'Flaky Test Report - Top 10',
      emoji: true
    }
  });

  // Calculate counts first
  const realFailures = summary.filter(test => test.realFailures > 0);
  const flakyTests = summary.filter(test => test.realFailures === 0);

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Period (UTC): ${dateDisplay} | Repo: ${env.REPOSITORY} | Failed CI Runs: ${failedCount}/${workflowCount} from ${env.BRANCH} branch\nFound: ${realFailures.length} tests failing, ${flakyTests.length} flaky (eventually passed)`
    }]
  });

  blocks.push({ type: 'divider' });

  if (summary.length === 0) {
    blocks.push({
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'No flaky tests found, great job! ✅ ' }
        ]
      }]
    });
    return blocks;
  }

  const top10 = summary.slice(0, 10);

  // Real failures section
  if (realFailures.length > 0) {
    blocks.push({
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'emoji', name: 'x' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'Failures', style: { bold: true } }
        ]
      }]
    });

    // Each failure
    top10.filter(test => test.realFailures > 0).forEach((test, idx) => {
      const globalIndex = top10.indexOf(test) + 1;
      const failText = test.realFailures === 1 ? 'time' : 'times';
      const retryText = test.totalRetries === 1 ? 'retry' : 'retries';

      // Create GitHub file URL
      const fileUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/blob/${env.BRANCH}/${test.path}`;

      // Build elements for this test
      const elements = [
        { type: 'text', text: `  ${globalIndex}. ` },  // 2 spaces indent
        { type: 'link', url: fileUrl, text: test.name },
        { type: 'text', text: ` (failed ${test.realFailures} ${failText}, ${test.totalRetries} ${retryText})`, style: { bold: true } }
      ];

      if (test.lastRealFailureJobId && test.lastRealFailureRunId) {
        const jobUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.lastRealFailureRunId}/job/${test.lastRealFailureJobId}`;
        elements.push(
          { type: 'text', text: ' - ' },
          { type: 'link', url: jobUrl, text: 'last log' }
        );
      }

      blocks.push({
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: elements
        }]
      });

      // Error message (if exists)
      const error = test.lastRealFailureError;
      if (error) {
        blocks.push({
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `  ${truncateError(error).replace(/\n/g, ' ')}`, style: { italic: true } }
            ]
          }]
        });
      }
    });
  }

  if (realFailures.length >= 10) {
    return blocks;
  }

  // Divider between sections if both exist
  if (realFailures.length > 0 && flakyTests.length > 0) {
    blocks.push({ type: 'divider' });
  }

  // Flaky tests section
  if (flakyTests.length > 0) {
    // Title
    blocks.push({
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'emoji', name: 'large_yellow_circle' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'Flaky (eventually passed)', style: { bold: true } }
        ]
      }]
    });

    // Each flaky test (respecting the 10-item limit)
    const displayedRealFailures = Math.min(realFailures.length, 10);
    const remainingSlots = 10 - displayedRealFailures;
    const flakyTestsToShow = flakyTests.slice(0, remainingSlots);

    flakyTestsToShow.forEach((test, idx) => {
      const globalIndex = displayedRealFailures + idx + 1;
      const retryText = test.totalRetries === 1 ? 'retry' : 'retries';

      // Create GitHub file URL
      const fileUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/blob/${env.BRANCH}/${test.path}`;

      // Build elements for this test
      const elements = [
        { type: 'text', text: `  ${globalIndex}. ` },  // 2 spaces indent
        { type: 'link', url: fileUrl, text: test.name },
        { type: 'text', text: ` (${test.totalRetries} ${retryText})`, style: { bold: true } }
      ];

      if (test.flakyFailureJobId && test.flakyFailureRunId) {
        const jobUrl = `https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.flakyFailureRunId}/job/${test.flakyFailureJobId}`;
        elements.push(
          { type: 'text', text: ' - ' },
          { type: 'link', url: jobUrl, text: 'last log' }
        );
      }

      blocks.push({
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: elements
        }]
      });

      // Error message (if exists)
      const error = test.flakyFailureError;
      if (error) {
        blocks.push({
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `     ${truncateError(error).replace(/\n/g, ' ')}`, style: { italic: true } }
            ]
          }]
        });
      }
    });
  }

  return blocks;
}

function displayResults(summary, dateDisplay) {
  console.log('\n' + '='.repeat(80));
  console.log(`📊 REPORT - ${dateDisplay}`);
  console.log('='.repeat(80));

  if (summary.length === 0) {
    console.log('\n✅ No failed tests found, great job!');
    return;
  }

  const realFailures = summary.filter(test => test.realFailures > 0);
  const flakyTests = summary.filter(test => test.realFailures === 0);

  console.log(`${realFailures.length} real failures (failed even after retries)`);
  console.log(`${flakyTests.length} flaky tests (eventually passed after retries)`);
  console.log(`\n📌 Sorted by: 1) Number of failures ↓  2) Total retries ↓`);
  console.log(`📊 Numbers shown are cumulative across all runs in the time period\n`);

  const top10 = summary.slice(0, 10);

  for (const [index, test] of top10.entries()) {
    console.log(`${(index + 1).toString().padStart(2)}. ${test.name}`);
    console.log(`    📁 File: ${test.path}`);

    if (test.realFailures > 0) {
      // Real failures (tests that failed even after retries)
      const failurePlural = test.realFailures > 1 ? 's' : '';
      const retryPlural = test.totalRetries > 1 ? 'retries' : 'retry';
      const retryText = test.totalRetries > 0 ? ` (${test.totalRetries} total ${retryPlural})` : '';
      console.log(`    ❌ Failed: ${test.realFailures} time${failurePlural}${retryText}`);

      // Show logs for real failures
      if (test.lastRealFailureJobId && test.lastRealFailureRunId) {
        console.log(`    🔗 Logs: https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.lastRealFailureRunId}/job/${test.lastRealFailureJobId}`);
      }

      // Show error for real failures
      if (test.lastRealFailureError) {
        console.log(`    💥 Error: ${truncateError(test.lastRealFailureError, 100).replace(/\n/g, ' ')}`);
      }
    } else {
      // Flaky tests (failed initially but eventually passed)
      const retryPlural = test.totalRetries > 1 ? 'retries' : 'retry';
      console.log(`    🟡 Flaky: eventually passed (${test.totalRetries} total ${retryPlural})`);

      // Show logs from when it failed (before retry succeeded)
      if (test.flakyFailureJobId && test.flakyFailureRunId) {
        console.log(`    🔗 Logs: https://github.com/${env.OWNER}/${env.REPOSITORY}/actions/runs/${test.flakyFailureRunId}/job/${test.flakyFailureJobId}`);
      }

      // Show error from initial failure
      if (test.flakyFailureError) {
        console.log(`    💥 Initial error: ${truncateError(test.flakyFailureError, 100).replace(/\n/g, ' ')}`);
      }
    }

    console.log('');
  }

  if (summary.length > 10) {
    console.log(`... and ${summary.length - 10} other tests\n`);
  }
}

async function main() {
  const github = new Octokit({ auth: env.GITHUB_TOKEN });

  console.log('🧪🧐 Flaky Test Report\n');

  const dateRange = getDateRange(env.LOOKBACK_DAYS);
  console.log(`Time range: ${dateRange.from} to ${dateRange.to}\n`);

  try {
    console.log('Fetching workflow runs...');
    const workflowRuns = await getWorkflowRuns(github, {
      owner: env.OWNER,
      repo: env.REPOSITORY,
      workflowId: env.WORKFLOW_ID,
      branch: env.BRANCH,
      from: dateRange.from,
      to: dateRange.to,
    });

    if (workflowRuns.length === 0) {
      console.log('⚠️ No workflow runs found.');
      return;
    }

    console.log(`Found ${workflowRuns.length} workflow run(s)`);

    // Count failed runs
    const failedRuns = workflowRuns.filter(run => run.conclusion === 'failure');
    console.log(`Failed CI Runs: ${failedRuns.length}/${workflowRuns.length} from ${env.BRANCH}`);

    console.log('Downloading their test artifacts...');
    const testData = await downloadTestArtifacts(github, workflowRuns);

    if (testData.length === 0) {
      console.log('⚠️  No test artifacts found in failed runs');
      return;
    }

    console.log('Analyzing test failures...');

    // Two-pass approach: process real failures and flaky tests separately
    const realFailures = extractRealFailures(testData);
    const flakyTests = extractFlakyTests(testData);

    const summary = summarizeFailures(realFailures, flakyTests);
    displayResults(summary, dateRange.display);
    await sendSlackReport(summary, dateRange.display, workflowRuns.length, failedRuns.length);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.status === 401) {
      console.log('\n💡 This might be a GitHub token issue. Make sure your token has the right permissions.');
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n❌ Unexpected error:', error);
  process.exit(1);
});
