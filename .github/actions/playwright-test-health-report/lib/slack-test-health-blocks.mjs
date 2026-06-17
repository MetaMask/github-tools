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

  const relevantItems = summary.filter(
    item =>
      item.brokenCount > 0 ||
      item.flakyCount > 0 ||
      (item.latestClassification === 'passed' && ((item.historicalBrokenCount ?? 0) > 0 || (item.historicalFlakyCount ?? 0) > 0)),
  );
  const topItems = relevantItems.slice(0, topN);
  const broken = topItems.filter(item => item.brokenCount > 0);
  const flaky = topItems.filter(item => item.brokenCount === 0 && item.flakyCount > 0);
  const review = topItems.filter(
    item =>
      item.latestClassification === 'passed' &&
      item.brokenCount === 0 &&
      item.flakyCount === 0 &&
      ((item.historicalBrokenCount ?? 0) > 0 || (item.historicalFlakyCount ?? 0) > 0),
  );

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
            `\nFound: ${broken.length} broken, ${flaky.length} flaky, ${review.length} review`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (topItems.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No broken/flaky/review tests found ✅' },
    });
    return blocks;
  }

  if (broken.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*❌ Broken*' },
    });

    broken.forEach((test, index) => {
      const globalIndex = index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const runUrl =
        test.lastBrokenRunUrl ||
        (test.lastBrokenRunId
          ? `https://github.com/${owner}/${repository}/actions/runs/${test.lastBrokenRunId}`
          : null);
      const line =
        `${globalIndex}. <${fileUrl}|${test.name}> (${test.projectName}) *failed ${test.brokenCount}x*` +
        (runUrl ? ` - <${runUrl}|run log>` : '');

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: line },
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
      text: { type: 'mrkdwn', text: '*🟡 Flaky*' },
    });

    flaky.forEach((test, index) => {
      const globalIndex = broken.length + index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const runUrl =
        test.lastFlakyRunUrl ||
        (test.lastFlakyRunId
          ? `https://github.com/${owner}/${repository}/actions/runs/${test.lastFlakyRunId}`
          : null);
      const line =
        `${globalIndex}. <${fileUrl}|${test.name}> (${test.projectName}) *flaky ${test.flakyCount}x*` +
        (runUrl ? ` - <${runUrl}|run log>` : '');

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: line },
      });

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_${truncateError(test.lastFlakyError)}_` },
      });
    });
  }

  if ((broken.length > 0 || flaky.length > 0) && review.length > 0) {
    blocks.push({ type: 'divider' });
  }

  if (review.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🟢 Review (now passing)*' },
    });

    review.forEach((test, index) => {
      const globalIndex = broken.length + flaky.length + index + 1;
      const fileUrl = `https://github.com/${owner}/${repository}/blob/${branch}/${test.path}`;
      const wasBroken = test.historicalBrokenCount ?? 0;
      const wasFlaky = test.historicalFlakyCount ?? 0;
      const line =
        `${globalIndex}. <${fileUrl}|${test.name}> (${test.projectName}) ` +
        `*now passing* (was broken ${wasBroken}x, flaky ${wasFlaky}x)`;

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: line },
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
