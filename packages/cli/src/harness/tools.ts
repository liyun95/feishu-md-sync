import type { HarnessWorkflow } from './task.js';

export type HarnessToolMode =
  | 'read'
  | 'write-task'
  | 'record-evidence'
  | 'dry-run-or-write'
  | 'readback-audit'
  | 'external-dry-run-or-write'
  | 'finalize';

export type HarnessTool = {
  name: string;
  mode: HarnessToolMode;
  writesFeishu: boolean;
  writesLocalFiles: boolean;
  writesExternalRepos: boolean;
  requires: string[];
  writeRequires: string[];
  artifacts: string[];
  description: string;
};

export type HarnessToolsRegistry = {
  kind: 'feishu-harness-tools';
  version: 1;
  workflow: HarnessWorkflow;
  tools: HarnessTool[];
};

const MULTISDK_TOOLS: HarnessTool[] = [
  {
    name: 'multisdk init',
    mode: 'write-task',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['feishuDoc', '--out'],
    writeRequires: [],
    artifacts: ['task.json', 'manifest.json', 'snippets/', 'environment.json', 'trace/events.jsonl'],
    description: 'Initialize a resumable multi-SDK task from a Feishu document.'
  },
  {
    name: 'multisdk status',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['taskDir'],
    writeRequires: [],
    artifacts: [],
    description: 'Show task progress from task.json.'
  },
  {
    name: 'multisdk export',
    mode: 'write-task',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['manifest.json', 'snippets/', 'task.json', 'trace/events.jsonl'],
    description: 'Refresh snippet files for one SDK language.'
  },
  {
    name: 'multisdk profile',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['language'],
    writeRequires: [],
    artifacts: [],
    description: 'Show validation profiles for one SDK language.'
  },
  {
    name: 'multisdk verify',
    mode: 'record-evidence',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language', '--evidence', '--command'],
    writeRequires: [],
    artifacts: ['task.json', 'evidence/evidence.json', 'evidence/evidence.md', 'trace/events.jsonl'],
    description: 'Record validation evidence for one SDK language.'
  },
  {
    name: 'multisdk diff',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['trace/events.jsonl'],
    description: 'Show a block-level diff before apply.'
  },
  {
    name: 'multisdk apply',
    mode: 'dry-run-or-write',
    writesFeishu: true,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: ['--write', 'validation evidence', 'fresh dry-run'],
    artifacts: ['task.json', 'trace/events.jsonl'],
    description: 'Dry-run or write one SDK language.'
  },
  {
    name: 'multisdk audit',
    mode: 'readback-audit',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['task.json', 'trace/events.jsonl'],
    description: 'Read back and audit one SDK language.'
  },
  {
    name: 'multisdk land-docs',
    mode: 'external-dry-run-or-write',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: true,
    requires: ['taskDir', 'language', '--repo', '--target'],
    writeRequires: ['--write', 'passing multisdk audit', 'branch hygiene when --base is provided'],
    artifacts: ['task.json', 'inputs/feishu.reviewed-baseline.md', 'trace/events.jsonl'],
    description: 'Patch reviewed Feishu code blocks into a local docs repo target.'
  },
  {
    name: 'multisdk finalize',
    mode: 'finalize',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir'],
    writeRequires: ['all languages audited'],
    artifacts: ['task.json', 'handoff.md', 'trace/events.jsonl'],
    description: 'Run final full audit and write the handoff summary.'
  },
  {
    name: 'doctor auth',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: [],
    writeRequires: [],
    artifacts: [],
    description: 'Report auth env loading without printing secrets.'
  },
  {
    name: 'code-blocks inspect',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['feishuDoc'],
    writeRequires: [],
    artifacts: [],
    description: 'Inspect Feishu code block inventory.'
  },
  {
    name: 'code-blocks audit',
    mode: 'readback-audit',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['feishuDoc', '--expect'],
    writeRequires: [],
    artifacts: [],
    description: 'Audit expected code-block languages, order, and placeholders.'
  },
  {
    name: 'pull',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['feishuDoc'],
    writeRequires: [],
    artifacts: ['output markdown when --output is provided'],
    description: 'Export current Feishu content as best-effort Markdown.'
  }
];

const BASELINE_SYNC_TOOLS: HarnessTool[] = [
  readTool('doctor auth', 'Report auth env loading without printing secrets.'),
  localTool('pull', ['feishuDoc'], ['output markdown when --output is provided'], 'Export current Feishu content as best-effort Markdown.'),
  readTool('status', 'Show local/remote sync status without writing.', ['markdownFile', 'feishuDoc']),
  readTool('diff', 'Show a best-effort diff between local Markdown and current Feishu content.', ['markdownFile', 'feishuDoc']),
  localTool('merge', ['markdownFile', 'feishuDoc'], ['merged Markdown file'], 'Merge local Markdown with current Feishu content into a .merged.md file.')
];

const PUSH_TOOLS: HarnessTool[] = [
  readTool('diff', 'Inspect local versus remote changes.', ['markdownFile', 'feishuDoc']),
  {
    name: 'push',
    mode: 'dry-run-or-write',
    writesFeishu: true,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['markdownFile', 'feishuDoc'],
    writeRequires: ['--write', 'approved dry-run strategy plan', '--replace-all when selected strategy is document-replace'],
    artifacts: ['dry-run/write output', 'readback verification'],
    description: 'Dry-run or write local Markdown changes using the selected block, section, or document push strategy.'
  }
];

const REFERENCE_AUTHORING_TOOLS: HarnessTool[] = [
  readTool('reference preflight', 'Check SDK source freshness before planning reference changes.', ['--sdk', '--repo', '--version-line']),
  localTool('reference plan', ['--impact', '--out'], ['reference manifest'], 'Convert an approved impact matrix into a publish manifest.'),
  {
    name: 'reference apply',
    mode: 'dry-run-or-write',
    writesFeishu: true,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['--manifest'],
    writeRequires: ['--write', 'approved manifest', 'dry-run review'],
    artifacts: ['Feishu apply report'],
    description: 'Dry-run or apply SDK reference writes to Feishu Drive and Bitable.'
  },
  readTool('reference audit', 'Read back resources referenced by a publish manifest.', ['--manifest'])
];

const REFERENCE_RELEASE_TOOLS: HarnessTool[] = [
  readTool('reference audit', 'Re-check Feishu state before release.', ['--manifest']),
  {
    name: 'reference export',
    mode: 'external-dry-run-or-write',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: true,
    requires: ['--manifest', '--web-content-repo', '--manual'],
    writeRequires: ['explicit human release intent', 'passing reference audit'],
    artifacts: ['web-content export report', 'changed files'],
    description: 'Export audited Feishu SDK references into a web-content checkout.'
  }
];

const RELEASE_NOTES_TOOLS: HarnessTool[] = [
  localTool('release init', ['--release-line', '--version', '--release-doc', '--milvus-docs', '--out'], ['task.json'], 'Initialize a release notes task.'),
  localTool('release pull', ['taskDir'], ['feishu/release-notes.remote.md'], 'Pull Feishu release notes into the task snapshot.'),
  localTool('release scan-sdk-tags', ['taskDir'], ['sdk/tags.json'], 'Scan SDK tag sources and write a version matrix.'),
  localTool('release audit', ['taskDir'], ['audit/report.md', 'audit/report.json'], 'Audit release notes, Variables.json, and user-doc links.'),
  localTool('release approve', ['taskDir', '--by'], ['approval hash in task.json'], 'Approve the current release report hash.'),
  {
    name: 'release apply',
    mode: 'external-dry-run-or-write',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: true,
    requires: ['taskDir'],
    writeRequires: ['--write', 'passing current audit', 'approval hash matches current report'],
    artifacts: ['local Milvus docs changes'],
    description: 'Dry-run or write approved release docs changes.'
  }
];

const SUPPORTED_WORKFLOWS: HarnessWorkflow[] = [
  'baseline-sync',
  'push',
  'multisdk-examples',
  'multisdk',
  'sdk-reference-authoring',
  'sdk-reference-web-content-release',
  'release-notes'
];

export function parseHarnessWorkflow(value: string): HarnessWorkflow {
  if (SUPPORTED_WORKFLOWS.includes(value as HarnessWorkflow)) return value as HarnessWorkflow;
  throw new Error(`Unsupported harness workflow ${value || '(empty)'}. Expected one of: ${SUPPORTED_WORKFLOWS.join(', ')}.`);
}

export function getHarnessTools(workflow: HarnessWorkflow): HarnessToolsRegistry {
  return {
    kind: 'feishu-harness-tools',
    version: 1,
    workflow,
    tools: toolsForWorkflow(workflow)
  };
}

function toolsForWorkflow(workflow: HarnessWorkflow): HarnessTool[] {
  if (workflow === 'multisdk' || workflow === 'multisdk-examples') return MULTISDK_TOOLS;
  if (workflow === 'baseline-sync') return BASELINE_SYNC_TOOLS;
  if (workflow === 'push') return PUSH_TOOLS;
  if (workflow === 'sdk-reference-authoring') return REFERENCE_AUTHORING_TOOLS;
  if (workflow === 'sdk-reference-web-content-release') return REFERENCE_RELEASE_TOOLS;
  return RELEASE_NOTES_TOOLS;
}

function readTool(name: string, description: string, requires: string[] = []): HarnessTool {
  return {
    name,
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires,
    writeRequires: [],
    artifacts: [],
    description
  };
}

function localTool(name: string, requires: string[], artifacts: string[], description: string): HarnessTool {
  return {
    name,
    mode: 'write-task',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires,
    writeRequires: [],
    artifacts,
    description
  };
}
