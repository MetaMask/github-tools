export type PullRequest = {
  number: number;
  title: string;
  url: string;
  requestedTeams: string[];
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
};

export type Reminder = {
  byTeam: Record<string, PullRequest[]>;
  fallback: {
    sharedByManyTeams: PullRequest[];
    noTeam: PullRequest[];
  };
};
