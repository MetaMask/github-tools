export function summarizeTestHealth(findings) {
  const summary = new Map();

  for (const finding of findings) {
    const existing = summary.get(finding.key);

    if (existing) {
      if (finding.classification === 'broken') {
        existing.brokenCount += 1;
        existing.lastBrokenRunId = finding.runId;
        existing.lastBrokenRunUrl = finding.runUrl;
        existing.lastBrokenError = finding.error;
      } else if (finding.classification === 'flaky') {
        existing.flakyCount += 1;
        existing.lastFlakyRunId = finding.runId;
        existing.lastFlakyRunUrl = finding.runUrl;
        existing.lastFlakyError = finding.error;
      }

      existing.totalRetries += finding.retries;
      if (finding.date >= existing.lastSeen) {
        existing.lastSeen = finding.date;
        existing.latestClassification = finding.classification;
      }
      continue;
    }

    summary.set(finding.key, {
      key: finding.key,
      name: finding.name,
      path: finding.path,
      projectName: finding.projectName,
      brokenCount: finding.classification === 'broken' ? 1 : 0,
      flakyCount: finding.classification === 'flaky' ? 1 : 0,
      totalRetries: finding.retries,
      lastSeen: finding.date,
      latestClassification: finding.classification,
      lastBrokenRunId: finding.classification === 'broken' ? finding.runId : undefined,
      lastBrokenRunUrl: finding.classification === 'broken' ? finding.runUrl : undefined,
      lastBrokenError: finding.classification === 'broken' ? finding.error : undefined,
      lastFlakyRunId: finding.classification === 'flaky' ? finding.runId : undefined,
      lastFlakyRunUrl: finding.classification === 'flaky' ? finding.runUrl : undefined,
      lastFlakyError: finding.classification === 'flaky' ? finding.error : undefined,
    });
  }

  return Array.from(summary.values())
    .map(item => {
      const latestIsBroken = item.latestClassification === 'broken';
      const latestIsFlaky = item.latestClassification === 'flaky';
      return {
        ...item,
        historicalBrokenCount: item.brokenCount,
        historicalFlakyCount: item.flakyCount,
        brokenCount: latestIsBroken ? item.brokenCount : 0,
        flakyCount: latestIsFlaky ? item.flakyCount : 0,
      };
    })
    .sort((a, b) => {
      if (a.brokenCount !== b.brokenCount) {
        return b.brokenCount - a.brokenCount;
      }
      if (a.flakyCount !== b.flakyCount) {
        return b.flakyCount - a.flakyCount;
      }
      return b.totalRetries - a.totalRetries;
    });
}
