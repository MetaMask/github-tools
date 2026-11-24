export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  hasApproval: boolean;
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    sharedByManyTeams: PullRequest[];
    readyToMerge: PullRequest[];
    needsOwner: PullRequest[];
  };
};
