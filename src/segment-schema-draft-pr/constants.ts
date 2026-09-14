export const AGREEMENT_PHRASE = 'I agree to open a draft Segment schema PR';

export const TODO_DESCRIPTION = 'TODO: fill description';

export const OPT_OUT_LABEL = 'no-schema-pr';

export const PROPOSAL_MARKER = '<!-- segment-schema-draft-pr:proposal -->';

export const BODY_START_MARKER = '<!-- segment-schema-draft-pr:start -->';

export const BODY_END_MARKER = '<!-- segment-schema-draft-pr:end -->';

export const DIFF_PREFILTER =
  /EVENT_NAME|MetaMetricsEventName|trackEvent|addProperties|createEventBuilder/u;

export const MAX_CHANGED_TS_FILES = 150;

export const IGNORED_GENERATE_OPT_PROPS = new Set(['action', 'name']);
