import { IncomingWebhook } from '@slack/webhook';

export function truncateError(message, maxLength = 150) {
  if (!message) {
    return 'No error details';
  }
  return message.length > maxLength ? `${message.substring(0, maxLength)}...` : message;
}

export async function sendSlackBatched(webhookUrl, blocks) {
  const webhook = new IncomingWebhook(webhookUrl);
  const batchSize = 50;

  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize);
    await webhook.send({ blocks: batch });
  }
}
