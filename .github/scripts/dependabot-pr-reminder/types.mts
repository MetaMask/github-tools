export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  hasApproval: boolean;
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    readyToMerge: PullRequest[];
    needsOwner: PullRequest[];
  };
};
