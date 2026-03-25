export interface FlakyTestFailure {
  name: string;
  path: string;
  realFailures: number;
  totalRetries: number;
  lastError: string;
  jobId: number;
  runId: number;
  suite: string;
  isFlaky: boolean;
}

export interface AnalysisResult {
  testName: string;
  testPath: string;
  classification: 'flaky_test' | 'app_bug' | 'infra_issue';
  confidence: number;
  rootCauseCategory: string;
  rootCauseExplanation: string;
  specificLines: string[];
  suggestedFix: string;
  additionalNotes: string;
}

export interface SlackFinding {
  failure: FlakyTestFailure;
  analysis: AnalysisResult;
  jobUrl: string;
  fileUrl: string;
}

export interface TestSourceContext {
  testFileContent: string;
  testFilePath: string;
  pageObjects: Array<{
    path: string;
    content: string;
  }>;
}

export interface PastFixExample {
  prNumber: number;
  title: string;
  diffContent: string;
}
