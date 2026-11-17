export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  hasApproval: boolean;
  ciFailing: boolean;
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    failingCi: PullRequest[];
    readyToMerge: PullRequest[];
    needsOwner: PullRequest[];
  };
};
