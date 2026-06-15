function isFailureResult(result) {
  return result.status === 'failed' || result.status === 'timedOut';
}

function classifyTest(test) {
  if (test.status === 'unexpected') {
    return 'broken';
  }
  if (test.status === 'flaky') {
    return 'flaky';
  }
  if (test.status === 'expected' || test.status === 'skipped') {
    return null;
  }

  const results = Array.isArray(test.results) ? test.results : [];
  if (results.length <= 1) {
    return null;
  }

  const lastResult = results[results.length - 1];
  const anyFailed = results.some(isFailureResult);
  if (!anyFailed) {
    return null;
  }

  return lastResult?.status === 'passed' ? 'flaky' : 'broken';
}

function extractFirstFailureError(test) {
  const results = Array.isArray(test.results) ? test.results : [];
  const firstFailure = results.find(isFailureResult);
  if (!firstFailure) {
    return 'No error details';
  }
  return firstFailure?.error?.message ?? firstFailure?.errors?.[0]?.message ?? 'No error details';
}

function walkSuites(suites, currentFile, findings, metadata) {
  for (const suite of suites ?? []) {
    const suiteFile = suite.file || currentFile;

    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const classification = classifyTest(test);
        if (!classification) {
          continue;
        }

        const projectName = test.projectName || 'default';
        const key = `${projectName}::${spec.file || suiteFile || 'unknown-file'}::${test.title}`;
        const results = Array.isArray(test.results) ? test.results : [];

        findings.push({
          key,
          name: test.title,
          path: spec.file || suiteFile || 'unknown-file',
          projectName,
          classification,
          retries: Math.max(0, results.length - 1),
          error: extractFirstFailureError(test),
          runId: metadata.runId,
          runUrl: metadata.runUrl,
          date: new Date(metadata.date),
        });
      }
    }

    walkSuites(suite.suites, suiteFile, findings, metadata);
  }
}

export function parsePlaywrightJsonReport(report, metadata) {
  const findings = [];
  walkSuites(report?.suites ?? [], undefined, findings, metadata);
  return findings;
}
