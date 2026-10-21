export type Platform = 'mobile' | 'extension';

export type Mode = 'propose' | 'create' | 'close';

export type Phase = 'generate' | 'publish';

export type PropertyType = 'string' | 'number' | 'boolean' | 'array';

export type EventCatalog = Map<string, string>;

export type PropertyBag = {
  key: string;
  type: PropertyType;
};

export type UnresolvedProperty = {
  eventName: string;
  key: string;
  file: string;
};

export type EventModel = {
  properties: Map<string, PropertyType>;
  unresolved: UnresolvedProperty[];
};

export type AnalyticsModel = {
  catalog: EventCatalog;
  events: Map<string, EventModel>;
};

export type EventChange = {
  enumKey: string;
  eventName: string;
};

export type RenameChange = {
  enumKey: string;
  fromName: string;
  toName: string;
};

export type PropertyChange = {
  eventName: string;
  key: string;
  type: PropertyType;
};

export type RemovedProperty = {
  eventName: string;
  key: string;
};

export type AnalyticsChangeSet = {
  eventsAdded: EventChange[];
  eventsRemoved: EventChange[];
  eventsRenamed: RenameChange[];
  propertiesAdded: PropertyChange[];
  propertiesRemoved: RemovedProperty[];
  typeChanges: PropertyChange[];
  unresolved: UnresolvedProperty[];
};

export type IntendedFileChange = {
  path: string;
  kind: 'create' | 'update';
  eventName: string;
};

export type GenerateSummary = {
  hasChanges: boolean;
  branch: string;
  changeset: AnalyticsChangeSet;
  intendedFiles: IntendedFileChange[];
  schemaPrNumber: number | null;
  schemaPrUrl: string | null;
};

export type ResolvedClientPr = {
  number: number;
  baseSha: string;
  headSha: string;
  authorLogin: string;
  isOpen: boolean;
  merged: boolean;
  isFork: boolean;
  hasOptOutLabel: boolean;
  headRepoFullName: string;
};

export type SchemaPr = {
  number: number;
  htmlUrl: string;
  body: string;
  draft: boolean;
};

export type PlatformConfig = {
  catalogFile: string;
  enumName: string;
  eventRefPrefix: string;
  trackingPlan: string;
  globals: string;
  defaultLibrary: string;
};
