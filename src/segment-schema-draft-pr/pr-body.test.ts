import {
  AGREEMENT_PHRASE,
  BODY_END_MARKER,
  BODY_START_MARKER,
  MAX_CHANGED_TS_FILES,
  PROPOSAL_MARKER,
} from './constants';
import {
  renderProposalComment,
  renderTooManyFilesComment,
  spliceSchemaPrBody,
} from './pr-body';
import type { AnalyticsChangeSet } from './types';

const CHANGESET: AnalyticsChangeSet = {
  eventsAdded: [{ enumKey: 'NEW_EVENT', eventName: 'New Event' }],
  eventsRemoved: [{ enumKey: 'GONE', eventName: 'Gone' }],
  eventsRenamed: [],
  propertiesAdded: [{ eventName: 'New Event', key: 'source', type: 'string' }],
  propertiesRemoved: [],
  typeChanges: [],
  unresolved: [],
};

const TEMPLATE = `### 1️⃣ Why is this change needed?

_Type here..._

### 2️⃣ What changed?

_Type here..._

### 3️⃣ Business Value checklist
`;

describe('pr-body', () => {
  it('includes the agreement sentence in a copy-paste block', () => {
    const body = renderProposalComment(CHANGESET, [
      {
        path: 'libraries/events/metamask-mobile-unsorted/new-event.yaml',
        kind: 'create',
        eventName: 'New Event',
      },
    ]);
    expect(body).toContain(PROPOSAL_MARKER);
    expect(body).toContain(AGREEMENT_PHRASE);
    expect(body).toContain('New Event');
    expect(body).toContain('Gone');
  });

  it('omits the agreement sentence when there are no writable YAML changes', () => {
    const listedOnly: AnalyticsChangeSet = {
      eventsAdded: [],
      eventsRemoved: [{ enumKey: 'GONE', eventName: 'Gone' }],
      eventsRenamed: [],
      propertiesAdded: [],
      propertiesRemoved: [],
      typeChanges: [],
      unresolved: [],
    };
    const body = renderProposalComment(listedOnly, []);
    expect(body).toContain(PROPOSAL_MARKER);
    expect(body).toContain('Gone');
    expect(body).not.toContain(AGREEMENT_PHRASE);
    expect(body).toContain('No draft will be opened from this pull request.');
  });

  it('tells the author to open the schema PR themselves when the file cap is exceeded', () => {
    const body = renderTooManyFilesComment(MAX_CHANGED_TS_FILES);
    expect(body).toContain(PROPOSAL_MARKER);
    expect(body).toContain(String(MAX_CHANGED_TS_FILES));
    expect(body).toContain(
      'Open the draft on Consensys/segment-schema yourself',
    );
  });

  it('splices only the generated block and keeps human template sections', () => {
    const first = spliceSchemaPrBody(
      '',
      TEMPLATE,
      'Client PR: https://example',
    );
    expect(first).toContain(BODY_START_MARKER);
    expect(first).toContain('Client PR: https://example');
    expect(first).toContain('### 3️⃣ Business Value checklist');

    const edited = first.replace('_Type here..._', 'Human why');
    const second = spliceSchemaPrBody(edited, TEMPLATE, 'Updated block');
    expect(second).toContain('Human why');
    expect(second).toContain('Updated block');
    expect(second).not.toContain('Client PR: https://example');
    expect(second.indexOf(BODY_START_MARKER)).toBeLessThan(
      second.indexOf(BODY_END_MARKER),
    );
  });
});
