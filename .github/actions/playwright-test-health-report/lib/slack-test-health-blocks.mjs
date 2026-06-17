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
  const infra = infraItems.slice(0, maxInfra);
  const flaky = flakyItems.slice(0, maxFlaky);
  const watch = watchItems.slice(0, maxWatch);
  const topItems = [...broken, ...infra, ...flaky, ...watch];

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
            `\nTests: ${brokenItems.length} failing, ${infraItems.length} infra, ${flakyItems.length} flaky, ${watchItems.length} watch` +
            ` | Showing ${broken.length}, ${infra.length}, ${flaky.length}, ${watch.length}`,
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
          elements: [{ type: 'text', text: 'No failing, infra, flaky, or watch issues found ✅' }],
        },
      ],
    });
    return blocks;
  }

  let itemIndex = 0;

  const sections = [
    {
      items: broken,
      emoji: 'x',
      title: 'Failing (latest run failed)',
      runKind: 'broken',
      statusText: test =>
        `failed ${formatRunRate(test.historicalBrokenCount ?? test.brokenCount, test.totalRuns)}`,
      error: test => test.lastBrokenError,
    },
    {
      items: infra,
      emoji: 'warning',
      title: 'Infra (setup failed, no tests ran)',
      runKind: 'infra',
      statusText: test =>
        `setup failed ${formatRunRate(test.historicalInfraCount ?? test.infraCount, test.totalRuns)}`,
      error: test => test.lastInfraError,
    },
    {
      items: flaky,
      emoji: 'large_yellow_circle',
      title: 'Flaky (latest run flaky)',
      runKind: 'flaky',
      statusText: test =>
        `flaky ${formatRunRate(test.historicalFlakyCount ?? test.flakyCount, test.totalRuns)}`,
      error: test => test.lastFlakyError,
    },
    {
      items: watch,
      emoji: 'large_green_circle',
      title: 'Watch (unstable in window, passing now)',
      runKind: 'broken',
      statusText: test => `now passing (${formatWatchHistory(test)})`,
      error: () => null,
    },
  ];

  let previousSectionHadItems = false;

  for (const section of sections) {
    if (section.items.length === 0) {
      continue;
    }

    if (previousSectionHadItems) {
      blocks.push({ type: 'divider' });
    }

    pushSectionHeader(blocks, section.emoji, section.title);

    for (const test of section.items) {
      itemIndex += 1;
      pushTestLine(blocks, {
        index: itemIndex,
        owner,
        repository,
        branch,
        test,
        statusText: section.statusText(test),
        runKind: section.runKind,
      });

      const error = section.error(test);
      if (error) {
        pushErrorLine(blocks, error);
      }
    }

    previousSectionHadItems = true;
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
