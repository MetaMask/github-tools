import {
  AGREEMENT_PHRASE,
  BODY_END_MARKER,
  BODY_START_MARKER,
  MAX_CHANGED_TS_FILES,
  PROPOSAL_MARKER,
} from './constants';
import { changesetHasWritableChanges } from './diff-models';
import type { AnalyticsChangeSet, IntendedFileChange, SchemaPr } from './types';

/**
 * Proposal comment asking the author to agree to open a draft schema PR.
 *
 * Why: listed-only diffs (removals, renames, type changes, unresolved) cannot
 * produce YAML, so the copy-paste agreement sentence is omitted.
 *
 * @param changeset - Detected analytics diff.
 * @param intendedFiles - YAML paths that would be written.
 * @returns Markdown body including the copy-paste agreement sentence when writable.
 */
export function renderProposalComment(
  changeset: AnalyticsChangeSet,
  intendedFiles: IntendedFileChange[],
): string {
  const lines = [
    PROPOSAL_MARKER,
    'This pull request looks like it changes analytics events or properties.',
    '',
    '### What triggered this',
    renderChangeset(changeset),
    '',
    '### Intended Segment schema files',
    renderIntendedFiles(intendedFiles),
    '',
  ];

  if (changesetHasWritableChanges(changeset)) {
    lines.push(
      'This does not block merge. To open a **draft** PR on the Segment schema repo, reply with:',
      '',
      '```',
      AGREEMENT_PHRASE,
      '```',
      '',
    );
  } else {
    lines.push(
      'Removals, renames, type changes, and unresolved keys need a human decision on the Segment schema repo. No draft will be opened from this pull request.',
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Proposal comment after the draft schema PR exists.
 *
 * @param schemaPr - Open schema PR.
 * @returns Status markdown.
 */
export function renderDraftOpenComment(schemaPr: SchemaPr): string {
  return [
    PROPOSAL_MARKER,
    `A draft Segment schema PR is open: ${schemaPr.htmlUrl}`,
    '',
    'Later analytics pushes on this pull request update that draft. Fill TODO descriptions, tick the checklists, then mark it ready for Data Council.',
    '',
  ].join('\n');
}

/**
 * Proposal comment when the current head no longer needs schema YAML.
 *
 * @returns Status markdown.
 */
export function renderNoLongerNeededComment(): string {
  return [
    PROPOSAL_MARKER,
    'The current head no longer has analytics changes that would update the Segment schema. No draft schema PR will be opened unless those changes return.',
    '',
  ].join('\n');
}

/**
 * Client PR comment after the draft is created.
 *
 * @param schemaPr - New schema PR.
 * @returns Markdown.
 */
export function renderCreatedComment(schemaPr: SchemaPr): string {
  return `Opened a draft Segment schema PR: ${schemaPr.htmlUrl}`;
}

/**
 * Client PR comment after the draft YAML is updated.
 *
 * @param schemaPr - Existing schema PR.
 * @returns Markdown.
 */
export function renderUpdatedComment(schemaPr: SchemaPr): string {
  return `Updated the draft Segment schema PR: ${schemaPr.htmlUrl}`;
}

/**
 * Client PR comment when the schema PR is kept but YAML is unchanged.
 *
 * @param schemaPr - Existing schema PR.
 * @returns Markdown.
 */
export function renderStaleComment(schemaPr: SchemaPr): string {
  return [
    PROPOSAL_MARKER,
    `This pull request no longer needs a Segment schema change. The draft stays open for reuse: ${schemaPr.htmlUrl}`,
    '',
  ].join('\n');
}

/**
 * Comment on the schema PR before closing it.
 *
 * @returns Markdown.
 */
export function renderClosedSchemaComment(): string {
  return 'Closing this draft because the linked client pull request was closed without merging.';
}

/**
 * Client comment when the opt-in window ends because the PR closed unmerged.
 *
 * @returns Markdown.
 */
export function renderWindowClosedComment(): string {
  return 'The Segment schema draft opt-in window ended because this pull request closed without merging. If you still need a schema change, open the draft on Consensys/segment-schema yourself.';
}

/**
 * Sticky comment when the PR is too large for automatic extraction.
 *
 * @param cap - Maximum non-test TypeScript files the generator will walk.
 * @returns Markdown.
 */
export function renderTooManyFilesComment(
  cap: number = MAX_CHANGED_TS_FILES,
): string {
  return [
    PROPOSAL_MARKER,
    `This pull request changes more than ${cap} non-test TypeScript files, so automatic Segment schema detection is skipped. Open the draft on Consensys/segment-schema yourself if this pull request changes analytics events.`,
    '',
  ].join('\n');
}

/**
 * Sticky comment when detection is skipped because of the file cap and a draft already exists.
 *
 * @param schemaPr - Existing schema PR.
 * @param cap - Maximum non-test TypeScript files the generator will walk.
 * @returns Markdown.
 */
export function renderTooManyFilesStaleComment(
  schemaPr: SchemaPr,
  cap: number = MAX_CHANGED_TS_FILES,
): string {
  return [
    PROPOSAL_MARKER,
    `This pull request no longer needs a Segment schema change. The draft stays open for reuse: ${schemaPr.htmlUrl}`,
    '',
    `Automatic detection was skipped because this pull request changes more than ${cap} non-test TypeScript files.`,
    '',
  ].join('\n');
}

/**
 * Proposal comment when the author agreed but YAML would be empty.
 *
 * @param changeset - Listed-only diff.
 * @returns Markdown.
 */
export function renderListedOnlyComment(changeset: AnalyticsChangeSet): string {
  return [
    PROPOSAL_MARKER,
    'Agreement received, but there are no additive YAML changes to open a draft schema PR. Removals, renames, type changes, and unresolved keys are listed only.',
    '',
    renderChangeset(changeset),
    '',
  ].join('\n');
}

/**
 * Replaces only the generated block in a schema PR body.
 *
 * @param existingBody - Current PR body, or empty for create.
 * @param template - Schema repo PR template (used when creating).
 * @param generatedBlock - Markdown for the generated section.
 * @returns Full body with markers preserved around human edits.
 */
export function spliceSchemaPrBody(
  existingBody: string,
  template: string,
  generatedBlock: string,
): string {
  const block = [
    BODY_START_MARKER,
    generatedBlock.trim(),
    BODY_END_MARKER,
  ].join('\n');
  const source = existingBody.trim() === '' ? template : existingBody;

  if (source.includes(BODY_START_MARKER) && source.includes(BODY_END_MARKER)) {
    const start = source.indexOf(BODY_START_MARKER);
    const end = source.indexOf(BODY_END_MARKER) + BODY_END_MARKER.length;
    return `${source.slice(0, start)}${block}${source.slice(end)}`;
  }

  if (source.includes('### 2️⃣ What changed?')) {
    return source.replace(
      '### 2️⃣ What changed?',
      `### 2️⃣ What changed?\n\n${block}`,
    );
  }

  return `${source.trim()}\n\n${block}\n`;
}

/**
 * Generated "What changed" block for the schema PR.
 *
 * @param clientPrUrl - Link to the Mobile/Extension PR.
 * @param changeset - Diff.
 * @param intendedFiles - Files written.
 * @returns Markdown inside the splice markers.
 */
export function renderGeneratedSchemaBlock(
  clientPrUrl: string,
  changeset: AnalyticsChangeSet,
  intendedFiles: IntendedFileChange[],
): string {
  return [
    `Client PR: ${clientPrUrl}`,
    '',
    renderChangeset(changeset),
    '',
    '### Files',
    renderIntendedFiles(intendedFiles),
    '',
    'Removals, renames, type changes, and `required: true` are listed for a human and were not applied.',
  ].join('\n');
}

/**
 * Renders the changeset as markdown lists.
 *
 * @param changeset - Diff.
 * @returns Markdown.
 */
function renderChangeset(changeset: AnalyticsChangeSet): string {
  const lines: string[] = [];

  if (changeset.eventsAdded.length > 0) {
    lines.push('**Events added**');
    for (const event of changeset.eventsAdded) {
      lines.push(`- \`${event.eventName}\` (\`${event.enumKey}\`)`);
    }
  }
  if (changeset.propertiesAdded.length > 0) {
    lines.push('**Properties added**');
    for (const property of changeset.propertiesAdded) {
      lines.push(
        `- \`${property.eventName}\`.${property.key} (${property.type})`,
      );
    }
  }
  if (changeset.eventsRemoved.length > 0) {
    lines.push('**Events removed (not applied)**');
    for (const event of changeset.eventsRemoved) {
      lines.push(`- \`${event.eventName}\``);
    }
  }
  if (changeset.eventsRenamed.length > 0) {
    lines.push('**Events renamed (not applied)**');
    for (const event of changeset.eventsRenamed) {
      lines.push(`- \`${event.fromName}\` → \`${event.toName}\``);
    }
  }
  if (changeset.propertiesRemoved.length > 0) {
    lines.push('**Properties removed (not applied)**');
    for (const property of changeset.propertiesRemoved) {
      lines.push(`- \`${property.eventName}\`.${property.key}`);
    }
  }
  if (changeset.typeChanges.length > 0) {
    lines.push('**Type changes (not applied)**');
    for (const property of changeset.typeChanges) {
      lines.push(
        `- \`${property.eventName}\`.${property.key} → ${property.type}`,
      );
    }
  }
  if (changeset.unresolved.length > 0) {
    lines.push('**Unresolved (not guessed as object)**');
    for (const item of changeset.unresolved) {
      lines.push(`- \`${item.eventName}\`.${item.key} in \`${item.file}\``);
    }
  }

  if (lines.length === 0) {
    return '_No additive analytics changes detected._';
  }

  return lines.join('\n');
}

/**
 * Renders intended YAML paths.
 *
 * @param intendedFiles - File list.
 * @returns Markdown list.
 */
function renderIntendedFiles(intendedFiles: IntendedFileChange[]): string {
  if (intendedFiles.length === 0) {
    return '_No YAML files would be written (listed-only changes)._';
  }
  return intendedFiles
    .map((file) => `- \`${file.path}\` (${file.kind}) — \`${file.eventName}\``)
    .join('\n');
}
