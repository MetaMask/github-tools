export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    sharedByManyTeams: PullRequest[];
    noTeam: PullRequest[];
  };
};
