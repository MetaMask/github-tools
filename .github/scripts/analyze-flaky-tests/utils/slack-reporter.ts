import { WebClient } from '@slack/web-api';
import type { SlackFinding } from '../types';

function buildSummaryBlocks(findings: SlackFinding[]): object[] {
  const flakyCount = findings.filter(
    (f) => f.analysis.classification === 'flaky_test',
  ).length;
  const bugCount = findings.filter(
    (f) => f.analysis.classification === 'app_bug',
  ).length;
  const infraCount = findings.filter(
    (f) => f.analysis.classification === 'infra_issue',
  ).length;

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `AI Analysis of ${findings.length} Flaky Tests`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Classification: ${flakyCount} flaky tests | ${bugCount} app bugs | ${infraCount} infra issues`,
        },
      ],
    },
    { type: 'divider' },
  ];
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}

function buildFindingBlocks(finding: SlackFinding): object[] {
  const { failure, analysis, jobUrl, fileUrl } = finding;

  const classificationEmoji =
    analysis.classification === 'flaky_test'
      ? ':large_yellow_circle:'
      : analysis.classification === 'app_bug'
        ? ':red_circle:'
        : ':white_circle:';

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(`Test: ${failure.name}`, 150),
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${classificationEmoji} ${analysis.classification.replace('_', ' ')} | Confidence: ${analysis.confidence}% | Root cause: ${analysis.rootCauseCategory}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Diagnosis*\n${truncate(analysis.rootCauseExplanation, 2900)}`,
      },
    },
  ];

  if (analysis.specificLines.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Problematic Code*\n\`\`\`${truncate(analysis.specificLines.join('\n'), 2900)}\`\`\``,
      },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Suggested Fix*\n${truncate(analysis.suggestedFix, 2900)}`,
    },
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<${jobUrl}|Job Log> | <${fileUrl}|Test File>`,
      },
    ],
  });

  blocks.push({ type: 'divider' });

  return blocks;
}

export async function postSlackFindings(
  findings: SlackFinding[],
  threadTs: string,
  botToken: string,
  channelId: string,
): Promise<void> {
  const slack = new WebClient(botToken);

  const summaryBlocks = buildSummaryBlocks(findings);
  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: summaryBlocks,
    text: `AI Analysis of ${findings.length} flaky tests`,
  });

  for (const finding of findings) {
    const blocks = buildFindingBlocks(finding);
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks,
      text: `Analysis: ${finding.failure.name}`,
    });
  }
}
