function createEntry(finding) {
  return {
    key: finding.key,
    name: finding.name,
    path: finding.path,
    projectName: finding.projectName,
    brokenCount: 0,
    flakyCount: 0,
    passedCount: 0,
    infraCount: 0,
    totalRuns: 0,
    totalRetries: 0,
    seenRunIds: new Set(),
    lastSeen: finding.date,
    latestClassification: finding.classification,
    lastBrokenRunId: undefined,
    lastBrokenRunUrl: undefined,
    lastBrokenError: undefined,
    lastFlakyRunId: undefined,
    lastFlakyRunUrl: undefined,
    lastFlakyError: undefined,
    lastInfraRunId: undefined,
    lastInfraRunUrl: undefined,
    lastInfraError: undefined,
  };
}

function applyClassification(entry, finding) {
  if (!entry.seenRunIds.has(finding.runId)) {
    entry.seenRunIds.add(finding.runId);
    entry.totalRuns += 1;
  }

  entry.totalRetries += finding.retries;

  if (finding.classification === 'broken') {
    entry.brokenCount += 1;
    entry.lastBrokenRunId = finding.runId;
    entry.lastBrokenRunUrl = finding.runUrl;
    entry.lastBrokenError = finding.error;
  } else if (finding.classification === 'flaky') {
    entry.flakyCount += 1;
    entry.lastFlakyRunId = finding.runId;
    entry.lastFlakyRunUrl = finding.runUrl;
    entry.lastFlakyError = finding.error;
  } else if (finding.classification === 'infra') {
    entry.infraCount += 1;
    entry.lastInfraRunId = finding.runId;
    entry.lastInfraRunUrl = finding.runUrl;
    entry.lastInfraError = finding.error;
  } else if (finding.classification === 'passed') {
    entry.passedCount += 1;
  }

  if (finding.date >= entry.lastSeen) {
    entry.lastSeen = finding.date;
    entry.latestClassification = finding.classification;
  }
}

export function summarizeTestHealth(findings) {
  const summary = new Map();

  for (const finding of findings) {
    const existing = summary.get(finding.key);
    if (existing) {
      applyClassification(existing, finding);
      continue;
    }

    const entry = createEntry(finding);
    applyClassification(entry, finding);
    summary.set(finding.key, entry);
  }

  return Array.from(summary.values())
    .map(item => {
      const { seenRunIds, ...rest } = item;
      return {
        ...rest,
        historicalBrokenCount: item.brokenCount,
        historicalFlakyCount: item.flakyCount,
        historicalInfraCount: item.infraCount,
      };
    })
    .sort((a, b) => {
      const latestRank = (classification, item) => {
        if (classification === 'broken' || classification === 'infra') {
          return 3;
        }
        if (classification === 'flaky') {
          return 2;
        }
        if ((item.brokenCount ?? 0) > 0 || (item.flakyCount ?? 0) > 0) {
          return 1;
        }
        return 0;
      };

      const rankA = latestRank(a.latestClassification, a);
      const rankB = latestRank(b.latestClassification, b);
      if (rankA !== rankB) {
        return rankB - rankA;
      }

      const instabilityA = a.brokenCount + a.flakyCount;
      const instabilityB = b.brokenCount + b.flakyCount;
      if (instabilityA !== instabilityB) {
        return instabilityB - instabilityA;
      }

      return b.totalRetries - a.totalRetries;
    });
}
