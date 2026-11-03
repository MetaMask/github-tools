/**
 * Safe defaults for the shared action.
 * Dry-run posts nothing and writes nothing. A pull request body is written
 * only for release validation, when dry-run is off, allow-pr-write is on,
 * and test-channel is empty. A test channel never writes a pull request body.
 */

/**
 * Parses the dry-run input. Unset stays on.
 *
 * @param {string | boolean | undefined} value - Action input. Unset or empty stays dry-run.
 * @returns {boolean} True unless the value is the string `false`.
 */
export function isDryRun(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return true;
  }
  return String(value).trim().toLowerCase() !== 'false';
}

/**
 * Parses allow-pr-write. Only the string true allows a write.
 *
 * @param {string | boolean | undefined} value - Action input. Only the string `true` allows a write.
 * @returns {boolean} Whether the caller asked to rewrite the release PR body.
 */
export function isPrWriteAllowed(value) {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/**
 * Decides whether this run may update a release pull request body.
 *
 * @param {object} args - Parsed flags.
 * @param {string} args.mode - `blocker-summary` or `release-validation`.
 * @param {boolean} args.dryRun - Parsed dry-run flag.
 * @param {boolean} args.allowPrWrite - Parsed allow-pr-write flag.
 * @param {string} [args.testChannel] - When set, the write is refused.
 * @returns {boolean} Whether this run may PATCH a pull request body.
 */
export function shouldWriteReleasePr({
  mode,
  dryRun,
  allowPrWrite,
  testChannel,
}) {
  if ((testChannel || '').trim()) {
    return false;
  }
  return (
    mode === 'release-validation' && dryRun === false && allowPrWrite === true
  );
}

/**
 * Chooses the Slack channel, honoring test-channel.
 *
 * @param {string} slackChannelName - Channel the Zap formula produced.
 * @param {string} testChannel - Override. When set, this is the only target.
 * @returns {string} Channel passed to `chat.postMessage`.
 */
export function postChannel(slackChannelName, testChannel) {
  const override = (testChannel || '').trim();
  return override || slackChannelName;
}
