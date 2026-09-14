/**
 * Pre-install gate for draft-segment-schema-pr.
 *
 * Why: this runs in `actions/github-script` before github-tools is checked
 * out and installed, so the constants are duplicated from
 * `src/segment-schema-draft-pr/constants.ts` rather than imported.
 */

export const AGREEMENT_PHRASE = 'I agree to open a draft Segment schema PR';

export const OPT_OUT_LABEL = 'no-schema-pr';

export const PROPOSAL_MARKER = '<!-- segment-schema-draft-pr:proposal -->';

export const DIFF_PREFILTER =
  /EVENT_NAME|MetaMetricsEventName|trackEvent|addProperties|createEventBuilder/u;

export const MAX_CHANGED_TS_FILES = 150;

export const CATALOG_FILES = {
  mobile: 'app/core/Analytics/MetaMetrics.events.ts',
  extension: 'shared/constants/metametrics.ts',
};

const TEST_PATH =
  /(?:^|\/)(?:__tests__\/|(?:[^/]+\.)?(?:test|spec)\.[jt]sx?$)/u;

/**
 * Builds the deterministic bot branch for one client PR.
 *
 * @param {string} platform - Mobile or extension.
 * @param {number} prNumber - Client pull request number.
 * @returns {string} Branch name `metamaskbot/<platform>-pr-<N>`.
 */
export function botBranchName(platform, prNumber) {
  return `metamaskbot/${platform}-pr-${prNumber}`;
}

/**
 * True for production TypeScript paths the analytics extractor walks.
 *
 * @param {string} filePath - Path relative to the repository root.
 * @returns {boolean} Whether the path is a non-test `.ts` / `.tsx` file.
 */
export function isNonTestTsFile(filePath) {
  return (
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) &&
    !TEST_PATH.test(filePath)
  );
}

/**
 * Returns a skip reason when the GitHub event does not match the requested mode.
 *
 * @param {string} mode - Workflow mode: propose, create, or close.
 * @param {string} eventName - Value of github.event_name.
 * @param {string} eventAction - Value of github.event.action.
 * @returns {string} Skip reason, or empty when the event matches.
 */
export function eventSkipReason(mode, eventName, eventAction) {
  if (mode === 'propose' || mode === 'close') {
    if (eventName !== 'pull_request') {
      return 'wrong-event';
    }
    if (mode === 'propose' && eventAction === 'closed') {
      return 'wrong-event';
    }
    if (mode === 'close' && eventAction !== 'closed') {
      return 'wrong-event';
    }
  }
  if (mode === 'create' && eventName !== 'issue_comment') {
    return 'wrong-event';
  }
  return '';
}

/**
 * True when the comment is the author's exact agreement sentence.
 *
 * @param {string} body - Comment body.
 * @param {string} commenterLogin - Comment author.
 * @param {string} prAuthorLogin - Pull request author.
 * @returns {boolean} Whether create should proceed past the comment check.
 */
export function isAgreementComment(body, commenterLogin, prAuthorLogin) {
  if (commenterLogin !== prAuthorLogin) {
    return false;
  }
  const firstLine = (body.split('\n')[0] ?? '').trim();
  return firstLine === AGREEMENT_PHRASE;
}

/**
 * Lists non-test TypeScript paths and whether their patches mention analytics APIs.
 *
 * @param {{ filename: string, patch?: string | null, previous_filename?: string }[]} files - PR file list.
 * @returns {{ files: string[], mentionsAnalytics: boolean }} Changed TS paths and pre-filter.
 */
export function collectTsDiff(files) {
  const tsFiles = new Set();
  let mentionsAnalytics = false;

  for (const item of files) {
    const candidates = [item.filename];
    if (item.previous_filename) {
      candidates.push(item.previous_filename);
    }

    const tsPaths = candidates.filter(isNonTestTsFile);
    if (tsPaths.length === 0) {
      continue;
    }

    for (const filePath of tsPaths) {
      tsFiles.add(filePath);
    }

    if (item.patch === undefined || item.patch === null) {
      mentionsAnalytics = true;
      continue;
    }
    if (DIFF_PREFILTER.test(item.patch)) {
      mentionsAnalytics = true;
    }
  }

  return { files: [...tsFiles], mentionsAnalytics };
}

/**
 * True when the PR file list looks like an analytics change.
 *
 * @param {{ files: string[], mentionsAnalytics: boolean }} diff - Result of collectTsDiff.
 * @param {string} platform - Mobile or extension.
 * @returns {boolean} Whether generate should run.
 */
export function hasAnalyticsDiff(diff, platform) {
  const catalog = CATALOG_FILES[platform];
  return diff.mentionsAnalytics || diff.files.includes(catalog);
}

/**
 * Whether the later generate step is allowed to git-push.
 *
 * @param {string} mode - Workflow mode.
 * @param {boolean} schemaPrExists - Open schema PR on the bot branch.
 * @param {boolean} clientPrOpen - Client PR still open (create only).
 * @param {boolean} canWriteYaml - Analytics diff within the file cap.
 * @returns {boolean} Whether a later generate and push is allowed.
 */
export function shouldPushSchema(
  mode,
  schemaPrExists,
  clientPrOpen,
  canWriteYaml,
) {
  if (!canWriteYaml) {
    return false;
  }
  if (mode === 'create' && clientPrOpen) {
    return true;
  }
  return mode === 'propose' && schemaPrExists;
}

/**
 * Decides skip / push / analytics outputs before the toolchain install.
 *
 * @param {object} input - Gate inputs.
 * @param {string} input.mode - Propose, create, or close.
 * @param {string} input.eventName - GitHub event name.
 * @param {string} input.eventAction - GitHub event action.
 * @param {object} input.pr - Resolved client pull request.
 * @param {number} input.pr.number - Pull request number.
 * @param {boolean} input.pr.isFork - Head repo is not github.repository.
 * @param {boolean} input.pr.hasOptOutLabel - Presence of the `no-schema-pr` label.
 * @param {boolean} input.pr.isOpen - PR state is open.
 * @param {boolean} input.pr.merged - PR was merged.
 * @param {string} input.pr.authorLogin - PR author.
 * @param {string} input.commentBody - Issue comment body.
 * @param {string} input.commenterLogin - Issue comment author.
 * @param {boolean} input.schemaPrExists - Open schema PR on the bot branch.
 * @param {boolean} input.hasProposalComment - Sticky proposal comment exists.
 * @param {{ filename: string, patch?: string | null, previous_filename?: string }[]} input.pullFiles - Pull request files.
 * @param {string} input.platform - Mobile or extension.
 * @returns {{ skip: boolean, skipReason: string, shouldPush: boolean, hasAnalyticsDiff: boolean, tooManyFiles: boolean, branch: string }} Gate decision.
 */
export function decideGate(input) {
  const branch = botBranchName(input.platform, input.pr.number);
  const skipped = (skipReason) => ({
    skip: true,
    skipReason,
    shouldPush: false,
    hasAnalyticsDiff: false,
    tooManyFiles: false,
    branch,
  });

  const eventSkip = eventSkipReason(
    input.mode,
    input.eventName,
    input.eventAction,
  );
  if (eventSkip) {
    return skipped(eventSkip);
  }

  if (input.pr.isFork) {
    return skipped('fork');
  }
  if (
    (input.mode === 'propose' || input.mode === 'create') &&
    input.pr.hasOptOutLabel
  ) {
    return skipped('opt-out');
  }
  if (input.mode === 'create' && !input.pr.isOpen) {
    return skipped('client-pr-closed');
  }
  if (
    input.mode === 'create' &&
    !isAgreementComment(
      input.commentBody,
      input.commenterLogin,
      input.pr.authorLogin,
    )
  ) {
    return skipped('agreement-mismatch');
  }
  if (input.mode === 'close' && !input.schemaPrExists) {
    return skipped('no-schema-pr');
  }

  let analyticsDiff = true;
  let tooManyFiles = false;
  if (input.mode !== 'close') {
    const diff = collectTsDiff(input.pullFiles ?? []);
    tooManyFiles = diff.files.length > MAX_CHANGED_TS_FILES;
    analyticsDiff = hasAnalyticsDiff(diff, input.platform);

    if (
      !tooManyFiles &&
      !analyticsDiff &&
      !input.schemaPrExists &&
      !input.hasProposalComment
    ) {
      return skipped('no-analytics-diff');
    }
  }

  return {
    skip: false,
    skipReason: '',
    shouldPush: shouldPushSchema(
      input.mode,
      input.schemaPrExists,
      input.pr.isOpen,
      analyticsDiff && !tooManyFiles,
    ),
    hasAnalyticsDiff: analyticsDiff,
    tooManyFiles,
    branch,
  };
}
