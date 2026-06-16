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

  const topItems = summary.slice(0, topN);
  const broken = topItems.filter(item => item.brokenCount > 0);
  const flaky = topItems.filter(item => item.brokenCount === 0 && item.flakyCount > 0);

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
            `\nFound: ${broken.length} broken, ${flaky.length} flaky`,
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
          elements: [{ type: 'text', text: 'No flaky or broken tests found ✅' }],
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
      const elements = [
        { type: 'text', text: `  ${globalIndex}. ` },
        { type: 'link', url: fileUrl, text: test.name },
        { type: 'text', text: ` (${test.projectName})` },
        { type: 'text', text: ` failed ${test.brokenCount}x`, style: { bold: true } },
      ];

      if (runUrl) {
        elements.push({ type: 'text', text: ' - ' }, { type: 'link', url: runUrl, text: 'run log' });
      }

      blocks.push({
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements }],
      });

      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: `  ${truncateError(test.lastBrokenError)}`, style: { italic: true } }],
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
      const elements = [
        { type: 'text', text: `  ${globalIndex}. ` },
        { type: 'link', url: fileUrl, text: test.name },
        { type: 'text', text: ` (${test.projectName})` },
        { type: 'text', text: ` flaky ${test.flakyCount}x`, style: { bold: true } },
      ];

      if (runUrl) {
        elements.push({ type: 'text', text: ' - ' }, { type: 'link', url: runUrl, text: 'run log' });
      }

      blocks.push({
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements }],
      });

      blocks.push({
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: `  ${truncateError(test.lastFlakyError)}`, style: { italic: true } }],
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
