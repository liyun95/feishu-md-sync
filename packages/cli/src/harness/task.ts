export type HarnessWorkflow =
  | 'baseline-sync'
  | 'section-sync'
  | 'reviewed-section-sync'
  | 'multisdk-examples'
  | 'multisdk'
  | 'sdk-reference-authoring'
  | 'sdk-reference-web-content-release'
  | 'release-notes';

export type HarnessTaskSummary = {
  kind: 'feishu-harness-task-summary';
  version: 1;
  workflow: HarnessWorkflow;
  taskDir: string | null;
  status: 'not-started' | 'in-progress' | 'dry-run-passed' | 'written' | 'audited' | 'passed' | 'blocked';
  subject: {
    document?: string;
    documentId?: string;
    localPath?: string;
    releaseVersion?: string;
    sdk?: string;
  };
  artifacts: Array<{
    path: string;
    required: boolean;
    exists?: boolean;
  }>;
  nextCommands: string[];
};

export type HarnessGradeResult = 'passed' | 'blocked' | 'incomplete';
export type HarnessGradeSeverity = 'passed' | 'blocked' | 'incomplete';

export type HarnessGradeCheck = {
  id: string;
  passed: boolean;
  severity: HarnessGradeSeverity;
  message: string;
};

export type HarnessGrade = {
  kind: 'feishu-harness-grade';
  version: 1;
  workflow: HarnessWorkflow;
  taskDir: string;
  generatedAt: string;
  result: HarnessGradeResult;
  checks: HarnessGradeCheck[];
  nextCommands: string[];
};
