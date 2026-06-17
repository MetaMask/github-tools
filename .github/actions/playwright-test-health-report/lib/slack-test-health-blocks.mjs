import { IncomingWebhook } from '@slack/webhook';
import {
  allocateBucketSlots,
  formatRunRate,
  formatWatchHistory,
  partitionSummary,
} from './classify-report-buckets.mjs';

export function normalizeErrorForSlack(message, maxLength = 120) {
  if (!message) {
    return 'No error details';
  }

  const withoutEmojiShortcodes = String(message).replace(/:[a-z0-9_+\-]+:/gi, ' ');
  const firstMeaningfulLine = withoutEmojiShortcodes
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  const normalized = (firstMeaningfulLine || withoutEmojiShortcodes)
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return 'No error details';
  }

  return normalized.length > maxLength ? `${normalized.substring(0, maxLength - 3)}...` : normalized;
}

export function truncateError(message, maxLength = 120) {
  return normalizeErrorForSlack(message, maxLength);
}

function buildRunUrl(owner, repository, test, kind) {
  const runUrlField = {
    broken: 'lastBrokenRunUrl',
    flaky: 'lastFlakyRunUrl',
    infra: 'lastInfraRunUrl',
  }[kind];
  const runIdField = {
    broken: 'lastBrokenRunId',
    flaky: 'lastFlakyRunId',
    infra: 'lastInfraRunId',
  }[kind];

  return (
    test[runUrlField] ||
    (test[runIdField]
      ? `https://github.com/${owner}/${repository}/actions/runs/${test[runIdField]}`
      : null)
  );
}

function pushSectionHeader(blocks, emoji, title) {
  blocks.push({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          ...(emoji ? [{ type: 'emoji', name: emoji }] : []),
          ...(emoji ? [{ type: 'text', text: ' ' }] : []),
          { type: 'text', text: title, style: { bold: true } },
        ],
      },
    ],
  });
}

function pushTestLine(blocks, { index, owner, repository, branch, test, statusText, runKind }) {
  const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
  const runUrl = buildRunUrl(owner, repository, test, runKind);

  blocks.push({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: `${index}. ` },
          { type: 'link', url: fileUrl, text: test.name },
          { type: 'text', text: ` (${test.projectName}) ` },
          { type: 'text', text: statusText, style: { bold: true } },
          ...(runUrl ? [{ type: 'text', text: ' - ' }, { type: 'link', url: runUrl, text: 'run log' }] : []),
        ],
      },
    ],
  });
}

function pushErrorLine(blocks, message) {
  blocks.push({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [{ type: 'text', text: truncateError(message), style: { italic: true } }],
      },
    ],
  });
}

export function createSlackBlocks(summary, dateDisplay, options) {
  const {
    owner,
    repository,
    branch,
    reportTitle,
    topN,
    workflowsScanned,
    workflowCount,
    testFailureRunCount,
    otherFailedRunCount,
    lookbackDays = 1,
  } = options;

  const { brokenItems, flakyItems, watchItems, infraItems } = partitionSummary(summary);
  const { maxBroken, maxFlaky, maxWatch, maxInfra } = allocateBucketSlots(topN, {
    broken: brokenItems.length,
    flaky: flakyItems.length,
    watch: watchItems.length,
    infra: infraItems.length,
  });

  const broken = brokenItems.slice(0, maxBroken);
  const flaky = flakyItems.slice(0, maxFlaky);
  const watch = watchItems.slice(0, maxWatch);
  const infra = infraItems.slice(0, maxInfra);
  const topItems = [...broken, ...flaky, ...watch, ...infra];

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${reportTitle} - Top ${topN}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `Period (UTC): ${dateDisplay} | Lookback: ${lookbackDays} day(s) | Repo: ${repository} | Workflows: ${workflowsScanned.join(', ')}` +
            `\nCI runs: ${workflowCount} on ${branch} | Test-failure runs: ${testFailureRunCount} | Other CI failures: ${otherFailedRunCount}` +
            `\nTests: ${brokenItems.length} broken, ${flakyItems.length} flaky, ${watchItems.length} watch, ${infraItems.length} infra` +
            ` | Showing ${broken.length}, ${flaky.length}, ${watch.length}, ${infra.length}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (topItems.length === 0) {
    blocks.push({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'No broken, flaky, watch, or infra issues found ✅' }],
        },
      ],
    });
    return blocks;
  }

  let itemIndex = 0;

  if (broken.length > 0) {
    pushSectionHeader(blocks, 'x', 'Broken (latest run failed)');
    broken.forEach(test => {
      itemIndex += 1;
      pushTestLine(blocks, {
        index: itemIndex,
        owner,
        repository,
        branch,
        test,
        statusText: `failed ${formatRunRate(test.historicalBrokenCount ?? test.brokenCount, test.totalRuns)}`,
        runKind: 'broken',
      });
      pushErrorLine(blocks, test.lastBrokenError);
    });
  }

  if (broken.length > 0 && (flaky.length > 0 || watch.length > 0 || infra.length > 0)) {
    blocks.push({ type: 'divider' });
  }

  if (flaky.length > 0) {
    pushSectionHeader(blocks, 'large_yellow_circle', 'Flaky (latest run flaky)');
    flaky.forEach(test => {
      itemIndex += 1;
      pushTestLine(blocks, {
        index: itemIndex,
        owner,
        repository,
        branch,
        test,
        statusText: `flaky ${formatRunRate(test.historicalFlakyCount ?? test.flakyCount, test.totalRuns)}`,
        runKind: 'flaky',
      });
      pushErrorLine(blocks, test.lastFlakyError);
    });
  }

  if (flaky.length > 0 && (watch.length > 0 || infra.length > 0)) {
    blocks.push({ type: 'divider' });
  }

  if (watch.length > 0) {
    pushSectionHeader(blocks, 'large_green_circle', 'Watch (unstable in window, passing now)');
    watch.forEach(test => {
      itemIndex += 1;
      pushTestLine(blocks, {
        index: itemIndex,
        owner,
        repository,
        branch,
        test,
        statusText: `now passing (${formatWatchHistory(test)})`,
        runKind: 'broken',
      });
    });
  }

  if (watch.length > 0 && infra.length > 0) {
    blocks.push({ type: 'divider' });
  }

  if (infra.length > 0) {
    pushSectionHeader(blocks, 'warning', 'Infra (setup failed, no tests ran)');
    infra.forEach(test => {
      itemIndex += 1;
      pushTestLine(blocks, {
        index: itemIndex,
        owner,
        repository,
        branch,
        test,
        statusText: `setup failed ${formatRunRate(test.historicalInfraCount ?? test.infraCount, test.totalRuns)}`,
        runKind: 'infra',
      });
      pushErrorLine(blocks, test.lastInfraError);
    });
  }

  return blocks;
}

export async function sendSlackBatched(webhookUrl, blocks) {
  const webhook = new IncomingWebhook(webhookUrl);
  const batchSize = 50;

  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize);
    await webhook.send({ blocks: batch });
  }
}
