function historicalBroken(test) {
  return test.historicalBrokenCount ?? test.brokenCount ?? 0;
}

function historicalFlaky(test) {
  return test.historicalFlakyCount ?? test.flakyCount ?? 0;
}

export function instabilityScore(test) {
  return historicalBroken(test) + historicalFlaky(test);
}

export function partitionSummary(summary) {
  const infraItems = summary
    .filter(test => test.latestClassification === 'infra')
    .sort((a, b) => (b.infraCount ?? 0) - (a.infraCount ?? 0));

  const brokenItems = summary
    .filter(test => test.latestClassification === 'broken')
    .sort((a, b) => historicalBroken(b) - historicalBroken(a));

  const flakyItems = summary
    .filter(test => test.latestClassification === 'flaky')
    .sort((a, b) => historicalFlaky(b) - historicalFlaky(a));

  const watchItems = summary
    .filter(
      test =>
        test.latestClassification === 'passed' &&
        (historicalBroken(test) > 0 || historicalFlaky(test) > 0),
    )
    .sort((a, b) => {
      const rateA = instabilityScore(a) / Math.max(a.totalRuns ?? 1, 1);
      const rateB = instabilityScore(b) / Math.max(b.totalRuns ?? 1, 1);
      if (rateB !== rateA) {
        return rateB - rateA;
      }
      return instabilityScore(b) - instabilityScore(a);
    });

  return { brokenItems, flakyItems, watchItems, infraItems };
}

export function allocateBucketSlots(topN, counts) {
  const { broken = 0, flaky = 0, watch = 0, infra = 0 } = counts;

  let maxBroken = Math.min(broken, Math.max(Math.ceil(topN * 0.4), broken > 0 ? 2 : 0));
  let maxFlaky = Math.min(flaky, Math.max(Math.ceil(topN * 0.25), flaky > 0 ? 2 : 0));
  let maxInfra = Math.min(infra, Math.max(Math.ceil(topN * 0.1), infra > 0 ? 1 : 0));
  let maxWatch = Math.min(watch, topN - maxBroken - maxFlaky - maxInfra);

  let remaining = topN - (maxBroken + maxFlaky + maxWatch + maxInfra);

  const buckets = [
    { key: 'watch', available: watch - maxWatch, max: maxWatch },
    { key: 'broken', available: broken - maxBroken, max: maxBroken },
    { key: 'flaky', available: flaky - maxFlaky, max: maxFlaky },
    { key: 'infra', available: infra - maxInfra, max: maxInfra },
  ].sort((a, b) => b.available - a.available);

  for (const bucket of buckets) {
    if (remaining <= 0) {
      break;
    }
    const extra = Math.min(remaining, bucket.available);
    bucket.max += extra;
    remaining -= extra;
  }

  const byKey = Object.fromEntries(buckets.map(bucket => [bucket.key, bucket.max]));

  return {
    maxBroken: byKey.broken,
    maxFlaky: byKey.flaky,
    maxWatch: byKey.watch,
    maxInfra: byKey.infra,
  };
}

export function formatRunRate(count, totalRuns) {
  if (!totalRuns || totalRuns <= 0) {
    return `${count}x`;
  }
  return `${count}/${totalRuns} runs`;
}

export function formatWatchHistory(test) {
  const parts = [];
  const broken = historicalBroken(test);
  const flaky = historicalFlaky(test);

  if (broken > 0) {
    parts.push(`broken ${formatRunRate(broken, test.totalRuns)}`);
  }
  if (flaky > 0) {
    parts.push(`flaky ${formatRunRate(flaky, test.totalRuns)}`);
  }

  return parts.join(', ');
}
