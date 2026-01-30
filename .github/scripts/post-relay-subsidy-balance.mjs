// Fetch Relay balances and generate a Slack Incoming Webhook payload (Block Kit).
const DEFAULT_RELAY_APP_FEES_ADDRESS =
  '0x8711E94aFc2463c9C2E75B84CA3d319c0131FA18';
const DEFAULT_ALERT_USD_THRESHOLD = 5000;
const DEFAULT_TOP_UP_MENTION = '<!subteam^S04NK4JHCJ0|@mm-earn-team>';

const HEADER_EMOJI = ':musd:';
const OK_EMOJI = '🟢';
const LOW_EMOJI = ':alert:';
const TOP_UP_EMOJI = ':rotating_light:';

const buildRelayBalancesUrl = (address) =>
  `https://api.relay.link/app-fees/${address}/balances`;

const parseAmountUsd = (value) => {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return NaN;
  }

  const normalized = value.trim();
  if (!normalized) {
    return NaN;
  }

  return Number(normalized);
};

const formatUsd = (value) => {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

  return `$${formatted}`;
};

const fetchRelayBalances = async ({ url, timeoutMs }) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Unexpected HTTP status ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
};

const validateRelayResponseShape = (data) => {
  if (!data || typeof data !== 'object') {
    throw new Error('Relay response is not an object');
  }

  if (!Array.isArray(data.balances)) {
    throw new Error('Relay response missing "balances" array');
  }

  return data.balances;
};

const computeTotalUsd = (balances) =>
  balances
    .map((b) => parseAmountUsd(b?.amountUsd))
    .filter((v) => Number.isFinite(v))
    .reduce((sum, v) => sum + v, 0);

const formatAsOfDate = (date) =>
  new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'UTC',
  }).format(date);

const buildSlackPayload = ({ totalUsd, alertUsdThreshold, asOfDate }) => {
  const isLow = totalUsd < alertUsdThreshold;
  const statusEmoji = isLow ? LOW_EMOJI : OK_EMOJI;
  const statusText = isLow ? '*LOW*' : '*OK*';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${HEADER_EMOJI} *Relay Subsidy Balance*`,
      },
    },
    { type: 'divider' },
  ];

  if (isLow) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${DEFAULT_TOP_UP_MENTION} ${TOP_UP_EMOJI} *Top-up needed* ${TOP_UP_EMOJI}\nBalance is below ${formatUsd(
          alertUsdThreshold,
        )}.`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*Balance*\n*${formatUsd(totalUsd)}*`,
      },
      {
        type: 'mrkdwn',
        text: `*Status*\n${statusEmoji} ${statusText}`,
      },
    ],
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${formatAsOfDate(asOfDate)} • Alert threshold: ${formatUsd(
          alertUsdThreshold,
        )}`,
      },
    ],
  });

  return {
    text: `Relay subsidy balance (total: ${formatUsd(totalUsd)})`,
    blocks,
  };
};

const main = async () => {
  const relayAddressRaw = process.env.RELAY_APP_FEES_ADDRESS;
  const relayAddress =
    typeof relayAddressRaw === 'string' && relayAddressRaw.trim()
      ? relayAddressRaw.trim()
      : DEFAULT_RELAY_APP_FEES_ADDRESS;
  const url = buildRelayBalancesUrl(relayAddress);

  const alertUsdThresholdRaw = process.env.RELAY_ALERT_USD_THRESHOLD;
  const configuredAlertUsdThreshold = Number(
    typeof alertUsdThresholdRaw === 'string' && alertUsdThresholdRaw.trim()
      ? alertUsdThresholdRaw.trim()
      : DEFAULT_ALERT_USD_THRESHOLD,
  );
  const normalizedAlertUsdThreshold = Number.isFinite(
    configuredAlertUsdThreshold,
  )
    ? configuredAlertUsdThreshold
    : DEFAULT_ALERT_USD_THRESHOLD;

  const timeoutMsRaw = process.env.RELAY_BALANCES_TIMEOUT_MS;
  const timeoutMs = Number(
    typeof timeoutMsRaw === 'string' && timeoutMsRaw.trim()
      ? timeoutMsRaw.trim()
      : 15000,
  );
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 15000;

  const relayData = await fetchRelayBalances({
    url,
    timeoutMs: normalizedTimeoutMs,
  });

  const balances = validateRelayResponseShape(relayData);
  const totalUsd = computeTotalUsd(balances);

  const payload = buildSlackPayload({
    totalUsd,
    alertUsdThreshold: normalizedAlertUsdThreshold,
    asOfDate: new Date(),
  });

  process.stdout.write(JSON.stringify(payload));
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`relay-balances-slack: ${message}`);
  process.exitCode = 1;
});
