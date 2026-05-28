export type WorkflowId =
  | 'baseline-sync'
  | 'section-sync'
  | 'multisdk-examples'
  | 'sdk-reference-authoring'
  | 'sdk-reference-web-content-release'
  | 'release-notes';

export type WorkflowStep = {
  id: string;
  purpose: string;
  command: string;
  writes: 'none' | 'local' | 'feishu' | 'external-repo';
  verifies: string;
};

export type WorkflowRecipe = {
  id: WorkflowId;
  title: string;
  whenToUse: string;
  primaryArtifacts: string[];
  steps: WorkflowStep[];
};

const RECIPES: WorkflowRecipe[] = [
  {
    id: 'baseline-sync',
    title: 'Pull Feishu to local Markdown baseline',
    whenToUse: 'Refresh local Markdown from current Feishu content before editing, comparison, or later section sync.',
    primaryArtifacts: ['local Markdown file', '.sync/feishu baseline receipt'],
    steps: [
      { id: 'auth', purpose: 'Check credentials without printing secrets.', command: 'md2feishu doctor auth', writes: 'none', verifies: 'APP_ID and APP_SECRET are present.' },
      { id: 'preview-pull', purpose: 'Export current Feishu content to a reviewable remote copy first.', command: "md2feishu pull '<feishu-doc>' --output <doc>.remote.md", writes: 'local', verifies: 'The remote copy exists and is reviewable.' },
      { id: 'review-diff', purpose: 'Compare the remote copy with any existing local baseline before replacement.', command: 'diff -u <existing-doc.md> <doc>.remote.md', writes: 'none', verifies: 'Diff is understood and scoped to expected remote edits.' },
      { id: 'replace-local', purpose: 'Replace an existing local baseline only after explicit overwrite intent.', command: "md2feishu pull '<feishu-doc>' --output <existing-doc.md> --overwrite --write-receipt", writes: 'local', verifies: 'The requested local file and receipt are refreshed from Feishu.' },
      { id: 'status', purpose: 'Confirm the refreshed file is the current baseline.', command: "md2feishu status <existing-doc.md> '<feishu-doc>'", writes: 'none', verifies: 'Status is clean, or any remaining mismatch is explained.' }
    ]
  },
  {
    id: 'section-sync',
    title: 'Sync one local Markdown section to Feishu',
    whenToUse: 'A local Markdown heading section is ready to replace the matching Feishu section while preserving the rest of the remote document.',
    primaryArtifacts: ['dry-run patch plan', 'Feishu readback verification'],
    steps: [
      { id: 'diff', purpose: 'Inspect local versus remote changes.', command: 'md2feishu diff <doc.md> <feishu-doc>', writes: 'none', verifies: 'The change scope is small enough for section sync.' },
      { id: 'dry-run', purpose: 'Plan the selected section replacement.', command: 'md2feishu sync <doc.md> <feishu-doc> --section "<heading>"', writes: 'none', verifies: 'Operation is replace-section and block counts look correct.' },
      { id: 'write', purpose: 'Write only the selected section.', command: 'md2feishu sync <doc.md> <feishu-doc> --section "<heading>" --write -y', writes: 'feishu', verifies: 'Readback verification passes.' }
    ]
  },
  {
    id: 'multisdk-examples',
    title: 'Complete and validate multi-language examples',
    whenToUse: 'A Feishu user doc has Python examples and missing Java, Node, Go, or REST examples.',
    primaryArtifacts: ['runs/<doc>/task.json', 'manifest.json', 'evidence/', 'trace/events.jsonl', 'grade.md'],
    steps: [
      { id: 'init', purpose: 'Create a task directory and code-block manifest.', command: 'md2feishu multisdk init <feishu-doc> --out runs/<doc-token>', writes: 'local', verifies: 'task.json, manifest.json, snippets, and environment.json exist.' },
      { id: 'tools', purpose: 'Show the allowed operation menu.', command: 'md2feishu harness tools --workflow multisdk', writes: 'none', verifies: 'The agent uses only listed tools.' },
      { id: 'export', purpose: 'Refresh one target language snippet lane.', command: 'md2feishu multisdk export runs/<doc-token> --language <language>', writes: 'local', verifies: 'Language snippets are ready.' },
      { id: 'verify', purpose: 'Record execution evidence.', command: 'md2feishu multisdk verify runs/<doc-token> --language <language> --evidence <log> --command "<command>"', writes: 'local', verifies: 'Evidence is copied and summarized.' },
      { id: 'dry-run', purpose: 'Plan Feishu code-block writes.', command: 'md2feishu multisdk apply runs/<doc-token> --language <language>', writes: 'local', verifies: 'Dry-run report passes.' },
      { id: 'write', purpose: 'Write verified snippets to Feishu.', command: 'md2feishu multisdk apply runs/<doc-token> --language <language> --write -y', writes: 'feishu', verifies: 'Write report passes.' },
      { id: 'audit', purpose: 'Read back and compare Feishu code blocks.', command: 'md2feishu multisdk audit runs/<doc-token> --language <language>', writes: 'local', verifies: 'Audit passes for the language.' },
      { id: 'grade', purpose: 'Summarize task completion and next commands.', command: 'md2feishu harness grade runs/<doc-token> --workflow multisdk', writes: 'local', verifies: 'Result is passed or nextCommands explains remaining work.' }
    ]
  },
  {
    id: 'sdk-reference-authoring',
    title: 'Author and publish SDK reference changes on Feishu',
    whenToUse: 'SDK source tags or scan output indicate Feishu SDK reference docs need updates.',
    primaryArtifacts: ['source freshness report', 'impact matrix', 'reference manifest', 'Feishu apply report', 'Feishu audit report'],
    steps: [
      { id: 'preflight', purpose: 'Check SDK source freshness.', command: 'md2feishu reference preflight --sdk <sdk> --repo <sdk-repo> --version-line <line> --scan-state <scan-state> --format json', writes: 'none', verifies: 'Latest tag and changed paths are explicit.' },
      { id: 'plan', purpose: 'Convert approved impact matrix into a publish manifest.', command: 'md2feishu reference plan --impact impact.json --out reference-manifest.json', writes: 'local', verifies: 'Manifest action count matches planned changes.' },
      { id: 'apply-dry-run', purpose: 'Dry-run Feishu writes.', command: 'md2feishu reference apply --manifest reference-manifest.json', writes: 'none', verifies: 'No failed actions.' },
      { id: 'apply-write', purpose: 'Write approved reference changes.', command: 'md2feishu reference apply --manifest reference-manifest.json --write -y', writes: 'feishu', verifies: 'No failed actions.' },
      { id: 'audit', purpose: 'Read back Feishu and Bitable targets.', command: 'md2feishu reference audit --manifest reference-manifest.json', writes: 'none', verifies: 'Audit passed.' }
    ]
  },
  {
    id: 'sdk-reference-web-content-release',
    title: 'Release audited SDK reference docs to web-content',
    whenToUse: 'A human has decided the Feishu SDK reference draft is ready to publish to the docs website.',
    primaryArtifacts: ['reference manifest', 'Feishu audit report', 'web-content export report', 'PR handoff report'],
    steps: [
      { id: 'audit', purpose: 'Re-check Feishu state before release.', command: 'md2feishu reference audit --manifest reference-manifest.json', writes: 'none', verifies: 'Audit passed for the exact manifest being released.' },
      { id: 'export', purpose: 'Pull audited Feishu output into web-content.', command: 'md2feishu reference export --manifest reference-manifest.json --web-content-repo <repo> --manual <manual>', writes: 'external-repo', verifies: 'diffCheck passed and changed paths are reported.' }
    ]
  },
  {
    id: 'release-notes',
    title: 'Audit and apply Milvus release-note updates',
    whenToUse: 'A Milvus release note Feishu doc must be reconciled with local docs and SDK version variables.',
    primaryArtifacts: ['release task dir', 'sdk/tags.json', 'audit/report.md', 'approval hash'],
    steps: [
      { id: 'init', purpose: 'Create release task state.', command: 'md2feishu release init --release-line <line> --version <version> --release-doc <doc> --milvus-docs <repo> --out runs/releases/<version>', writes: 'local', verifies: 'task.json exists.' },
      { id: 'pull', purpose: 'Snapshot Feishu release notes.', command: 'md2feishu release pull runs/releases/<version>', writes: 'local', verifies: 'feishu/release-notes.remote.md exists.' },
      { id: 'scan', purpose: 'Collect SDK tag matrix.', command: 'md2feishu release scan-sdk-tags runs/releases/<version>', writes: 'local', verifies: 'sdk/tags.json exists.' },
      { id: 'audit', purpose: 'Audit variables, release notes, and user-doc links.', command: 'md2feishu release audit runs/releases/<version>', writes: 'local', verifies: 'audit/report.md shows passed or blockers.' },
      { id: 'approve', purpose: 'Approve exact audit hash.', command: 'md2feishu release approve runs/releases/<version> --by <name>', writes: 'local', verifies: 'Approval is recorded for current report hash.' },
      { id: 'apply', purpose: 'Apply approved local docs changes.', command: 'md2feishu release apply runs/releases/<version> --write', writes: 'external-repo', verifies: 'Only planned local docs files changed.' }
    ]
  }
];

export function listWorkflowRecipes(): WorkflowRecipe[] {
  return RECIPES;
}

export function getWorkflowRecipe(id: WorkflowId | string): WorkflowRecipe {
  const recipe = RECIPES.find((item) => item.id === id);
  if (!recipe) throw new Error(`Unknown workflow ${id}. Run md2feishu workflow list.`);
  return recipe;
}
