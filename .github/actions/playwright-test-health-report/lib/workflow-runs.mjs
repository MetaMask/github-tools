export function getDateRange(lookbackDays = 1) {
  const today = new Date();
  const daysAgo = new Date(today.getTime() - (lookbackDays * 24 * 60 * 60 * 1000));

  const fromDisplay = daysAgo.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const toDisplay = today.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return {
    from: daysAgo.toISOString(),
    to: today.toISOString(),
    display: `${fromDisplay} - ${toDisplay}`,
  };
}

export async function getWorkflowRuns(github, { owner, repo, workflowId, branch, from, to }) {
  try {
    const runs = await github.paginate(
      github.rest.actions.listWorkflowRuns,
      {
        owner,
        repo,
        workflow_id: workflowId,
        branch,
        created: `${from}..${to}`,
        per_page: 100,
      },
    );

    const completedRuns = runs.filter(
      run => run.status === 'completed' && (run.event === 'push' || run.event === 'schedule'),
    );
    completedRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return completedRuns;
  } catch (error) {
    if (error.status === 404) {
      throw new Error(`Workflow '${workflowId}' not found in ${owner}/${repo}`);
    }
    throw error;
  }
}
