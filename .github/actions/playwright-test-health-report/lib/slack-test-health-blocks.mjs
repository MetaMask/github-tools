import { IncomingWebhook } from '@slack/webhook';

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

export function createSlackBlocks(summary, dateDisplay, options) {
  const {
    owner,
    repository,
    branch,
    reportTitle,
    topN,
    workflowsScanned,
    failedRunCount,
    workflowCount,
  } = options;

  const maxBroken = Math.max(Math.ceil(topN * 0.5), 3);
  const maxFlaky = Math.max(Math.ceil(topN * 0.3), 2);
  const maxReview = Math.max(Math.ceil(topN * 0.2), 1);

  const brokenItems = summary.filter(item => item.brokenCount > 0);
  const flakyItems = summary.filter(item => item.brokenCount === 0 && item.flakyCount > 0);
  const reviewItems = summary.filter(
    item =>
      item.latestClassification === 'passed' &&
      item.brokenCount === 0 &&
      item.flakyCount === 0 &&
      ((item.historicalBrokenCount ?? 0) > 0 || (item.historicalFlakyCount ?? 0) > 0),
  );

  const broken = brokenItems.slice(0, maxBroken);
  const flaky = flakyItems.slice(0, maxFlaky);
  const review = reviewItems.slice(0, maxReview);
  const topItems = [...broken, ...flaky, ...review];

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
            `Period (UTC): ${dateDisplay} | Repo: ${repository} | Workflows: ${workflowsScanned.join(', ')} | ` +
            `Failed CI Runs: ${failedRunCount}/${workflowCount} from ${branch}` +
            `\nTotal: ${brokenItems.length} broken, ${flakyItems.length} flaky, ${reviewItems.length} review | Showing top ${broken.length}, ${flaky.length}, ${review.length}`,
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
          elements: [{ type: 'text', text: 'No broken/flaky/review tests found ✅' }],
        },
      ],
    });
    return blocks;
  }

  if (broken.length > 0) {
    blocks.push({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'emoji', name: 'x' },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'Broken', style: { bold: true } },
          ],
        },
      ],
    });

    broken.forEach((test, index) => {
      const globalIndex = index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const runUrl =
        test.lastBrokenRunUrl ||
        (test.lastBrokenRunId
          ? `https://github.com/${owner}/${repository}/actions/runs/${test.lastBrokenRunId}`
          : null);
      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `${globalIndex}. ` },
              { type: 'link', url: fileUrl, text: test.name },
              { type: 'text', text: ` (${test.projectName}) ` },
              { type: 'text', text: `failed ${test.brokenCount}x`, style: { bold: true } },
              ...(runUrl ? [{ type: 'text', text: ' - ' }, { type: 'link', url: runUrl, text: 'run log' }] : []),
            ],
          },
        ],
      });

      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: truncateError(test.lastBrokenError), style: { italic: true } }],
          },
        ],
      });
    });
  }

  if (broken.length > 0 && flaky.length > 0) {
    blocks.push({ type: 'divider' });
  }

  if (flaky.length > 0) {
    blocks.push({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'emoji', name: 'large_yellow_circle' },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'Flaky', style: { bold: true } },
          ],
        },
      ],
    });

    flaky.forEach((test, index) => {
      const globalIndex = broken.length + index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const runUrl =
        test.lastFlakyRunUrl ||
        (test.lastFlakyRunId
          ? `https://github.com/${owner}/${repository}/actions/runs/${test.lastFlakyRunId}`
          : null);
      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `${globalIndex}. ` },
              { type: 'link', url: fileUrl, text: test.name },
              { type: 'text', text: ` (${test.projectName}) ` },
              { type: 'text', text: `flaky ${test.flakyCount}x`, style: { bold: true } },
              ...(runUrl ? [{ type: 'text', text: ' - ' }, { type: 'link', url: runUrl, text: 'run log' }] : []),
            ],
          },
        ],
      });

      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: truncateError(test.lastFlakyError), style: { italic: true } }],
          },
        ],
      });
    });
  }

  if ((broken.length > 0 || flaky.length > 0) && review.length > 0) {
    blocks.push({ type: 'divider' });
  }

  if (review.length > 0) {
    blocks.push({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'emoji', name: 'large_green_circle' },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'Review (now passing)', style: { bold: true } },
          ],
        },
      ],
    });

    review.forEach((test, index) => {
      const globalIndex = broken.length + flaky.length + index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const wasBroken = test.historicalBrokenCount ?? 0;
      const wasFlaky = test.historicalFlakyCount ?? 0;
      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: `${globalIndex}. ` },
              { type: 'link', url: fileUrl, text: test.name },
              { type: 'text', text: ` (${test.projectName}) ` },
              { type: 'text', text: 'now passing', style: { bold: true } },
              { type: 'text', text: ` (was broken ${wasBroken}x, flaky ${wasFlaky}x)` },
            ],
          },
        ],
      });
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
