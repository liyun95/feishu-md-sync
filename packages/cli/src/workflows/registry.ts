export type WorkflowId =
  | 'baseline-sync'
  | 'publish-new'
  | 'push'
  | 'review-draft'
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
    whenToUse: 'Refresh local Markdown from current Feishu content before editing, comparison, or later Feishu push.',
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
    id: 'publish-new',
    title: 'Publish a new Feishu document',
    whenToUse: 'A local Markdown file has no corresponding Feishu document yet and needs a first publication plus local receipt binding.',
    primaryArtifacts: ['new Feishu docx URL', '.sync/feishu receipt'],
    steps: [
      { id: 'dry-run', purpose: 'Plan the new document title, destination, duplicate check, and block creation.', command: 'md2feishu publish-new <doc.md>', writes: 'none', verifies: 'Title, destination, strategy, duplicate candidates, and block count are clear.' },
      { id: 'write', purpose: 'Create the new Feishu document after reviewing the dry-run.', command: 'md2feishu publish-new <doc.md> --write -y', writes: 'feishu', verifies: 'Readback verification passes and a receipt is written.' },
      { id: 'next-push', purpose: 'Use the returned URL for subsequent updates.', command: "md2feishu push <doc.md> '<new-feishu-url>'", writes: 'none', verifies: 'The push dry-run reads the newly published target.' },
      { id: 'visual-verify', purpose: 'Confirm rendered Feishu content and final wiki or folder placement.', command: 'Open the returned Feishu URL and inspect the document.', writes: 'none', verifies: 'No unexpected formatting, escaped Markdown, duplicate placement, or missing wiki move is visible.' }
    ]
  },
  {
    id: 'push',
    title: 'Push local Markdown changes to Feishu',
    whenToUse: 'Local Markdown changes are ready to write back to an existing Feishu document after dry-run strategy review.',
    primaryArtifacts: ['push strategy plan', 'Feishu readback verification'],
    steps: [
      { id: 'dry-run', purpose: 'Plan the push and let the CLI choose block, section, or document strategy.', command: 'md2feishu push <doc.md> <feishu-doc>', writes: 'none', verifies: 'Selected strategy, scope, risk, and operation counts are clear.' },
      { id: 'write', purpose: 'Apply the reviewed push plan.', command: 'md2feishu push <doc.md> <feishu-doc> --write -y', writes: 'feishu', verifies: 'Readback verification passes.' },
      { id: 'replace-all', purpose: 'Apply a high-risk whole-document replacement only when explicitly intended.', command: 'md2feishu push <doc.md> <feishu-doc> --strategy document-replace --replace-all --write -y', writes: 'feishu', verifies: 'Dry-run recommended document-replace and the full replacement was approved.' },
      { id: 'visual-verify', purpose: 'Confirm rendered Feishu content looks correct after the write.', command: 'Open the Feishu document and inspect the changed area.', writes: 'none', verifies: 'No unexpected formatting, escaped Markdown, or unrelated content changes are visible.' }
    ]
  },
  {
    id: 'review-draft',
    title: 'Push a Milvus review draft to Feishu',
    whenToUse: 'A Milvus docs Markdown draft is ready for Feishu review and needs Milvus publish transforms, public docs links, review checks, and a refreshed post-write baseline.',
    primaryArtifacts: ['remote baseline Markdown', 'review draft dry-run', 'review draft checks', '.sync/feishu receipt'],
    steps: [
      { id: 'pull-baseline', purpose: 'Snapshot the current Feishu document before preparing the review draft write.', command: "md2feishu pull '<feishu-doc>' --output <doc>.remote.md --write-receipt --receipt-dir <project>/.sync/feishu", writes: 'local', verifies: 'The remote baseline and receipt exist before any Feishu write.' },
      { id: 'dry-run', purpose: 'Plan the Milvus review draft push with public link rewriting and review checks.', command: 'md2feishu review-draft <doc.md> <feishu-doc> --link-base-url https://milvus.io/docs/', writes: 'none', verifies: 'Selected strategy, operation counts, transforms, render risks, and review draft checks are clear.' },
      { id: 'write', purpose: 'Apply the reviewed Milvus draft after the dry-run is approved.', command: 'md2feishu review-draft <doc.md> <feishu-doc> --link-base-url https://milvus.io/docs/ --write -y', writes: 'feishu', verifies: 'Review draft checks pass and readback verification passes.' },
      { id: 'post-write-baseline', purpose: 'Pull the written Feishu document back into a local baseline receipt.', command: "md2feishu pull '<feishu-doc>' --output <doc>.remote.md --overwrite --write-receipt --receipt-dir <project>/.sync/feishu", writes: 'local', verifies: 'The post-write remote baseline matches the Feishu document used for later status, diff, and merge.' }
    ]
  },
  {
    id: 'multisdk-examples',
    title: 'Complete and validate one multi-SDK example lane',
    whenToUse: 'A Feishu user doc has Python examples and needs one reviewed Java, Node, Go, or REST lane.',
    primaryArtifacts: ['runs/<doc>-<language>/task.json', 'manifest.json', 'work/', 'outputs/review.md', 'evidence/', 'trace/events.jsonl', 'grade.md'],
    steps: [
      { id: 'confirm-language', purpose: 'Ask the user for exactly one target language.', command: 'Ask: Which one target SDK language should this run complete: Java, Node.js/JavaScript, Go, or REST?', writes: 'none', verifies: 'The user selected exactly one language before init.' },
      { id: 'init', purpose: 'Create a single-language task from the Feishu document.', command: 'md2feishu multisdk init https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --out runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --language java', writes: 'local', verifies: 'task.json, manifest.json, snippets, and environment.json exist for one language.' },
      { id: 'confirm-environment', purpose: 'Ask the user for the Milvus version or source ref, then record it.', command: 'md2feishu multisdk environment runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --milvus-version 2.6.0', writes: 'local', verifies: 'The user confirmed the Milvus target and task.json records it.' },
      { id: 'prepare', purpose: 'Create verifier artifacts from Python context and selected-language snippets.', command: 'md2feishu multisdk prepare runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java', writes: 'local', verifies: 'work/java/ contains python context, snippets, and verifier scaffold.' },
      { id: 'author', purpose: 'Fill selected-language snippets from the Python context and record them as authored.', command: 'md2feishu multisdk author runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java', writes: 'local', verifies: 'Selected-language snippets are non-empty and copied into work/java/snippets/.' },
      { id: 'validate', purpose: 'Run examples against real Milvus, defaulting to Manta.', command: 'md2feishu multisdk validate runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --runner manta --command "mvn test"', writes: 'local', verifies: 'evidence contains a completed Manta or local live validation log.' },
      { id: 'apply-local', purpose: 'Write reviewed examples into local Markdown only.', command: 'md2feishu multisdk apply-local runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java', writes: 'local', verifies: 'outputs/review.md and outputs/review.diff exist.' },
      { id: 'push-dry-run', purpose: 'Show the Feishu push plan for the reviewed Markdown.', command: 'md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf', writes: 'none', verifies: 'The user reviews the push dry-run plan.' },
      { id: 'record-push-dry-run', purpose: 'Record the reviewed push dry-run in the multi-SDK task.', command: 'md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode dry-run --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf"', writes: 'local', verifies: 'task.json records remote dry-run state.' },
      { id: 'push-write', purpose: 'Push reviewed Markdown to Feishu after user approval.', command: 'md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y', writes: 'feishu', verifies: 'Push readback verification passes.' },
      { id: 'record-push-write', purpose: 'Record the push result in the multi-SDK task.', command: 'md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode write --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y"', writes: 'local', verifies: 'task.json records remote write state.' },
      { id: 'audit', purpose: 'Audit the selected language after push.', command: 'md2feishu multisdk audit runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java', writes: 'local', verifies: 'Selected language is audited.' },
      { id: 'grade', purpose: 'Summarize the single-language task.', command: 'md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk', writes: 'local', verifies: 'Result is passed or nextCommands explains remaining work.' }
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
