export type HarnessWorkflow = 'multisdk';

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

export function parseHarnessWorkflow(value: string): HarnessWorkflow {
  if (value === 'multisdk') return value;
  throw new Error(`Unsupported harness workflow ${value || '(empty)'}. Expected multisdk.`);
}

export function getHarnessTools(workflow: HarnessWorkflow): HarnessToolsRegistry {
  return {
    kind: 'feishu-harness-tools',
    version: 1,
    workflow,
    tools: workflow === 'multisdk' ? MULTISDK_TOOLS : []
  };
}
