import type { MultisdkTask } from './task.js';

export function renderMultisdkHandoff(task: MultisdkTask): string {
  const lines = [
    '# Multi-SDK Handoff',
    '',
    `Document: ${task.document}`,
    `Document ID: ${task.documentId}`,
    `Task dir: ${task.taskDir}`,
    `Language: ${task.language}`,
    `Status: ${task.status}`,
    `Final audit: ${task.finalAuditPassed ? 'passed' : 'not passed'}`,
    ''
  ];

  if (task.milvusTarget) {
    lines.push('## Milvus Target', '');
    lines.push(`- kind: ${task.milvusTarget.kind}`);
    lines.push(`- version: ${task.milvusTarget.version}`);
    if (task.milvusTarget.sourceRepo) lines.push(`- source repo: ${task.milvusTarget.sourceRepo}`);
    if (task.milvusTarget.sourceRef) lines.push(`- source ref: ${task.milvusTarget.sourceRef}`);
    lines.push('');
  }

  lines.push('## Lane', '');
  lines.push(`- prepared: ${task.lane.prepared}`);
  lines.push(`- authored: ${task.lane.authored}`);
  lines.push(`- validated: ${task.lane.validated}`);
  lines.push(`- local applied: ${task.lane.localApplied}`);
  lines.push(`- remote written: ${task.lane.remoteWritten}`);
  lines.push(`- audited: ${task.lane.audited}`);
  if (task.lane.reason) lines.push(`- reason: ${task.lane.reason}`);
  for (const evidence of task.lane.evidence) {
    lines.push(`- evidence: ${evidence.evidencePath}`);
    lines.push(`  - runner: ${evidence.runner}`);
    lines.push(`  - command: ${evidence.command}`);
    if (evidence.jobId) lines.push(`  - Manta job: ${evidence.jobId}`);
  }

  if (task.localReview) {
    lines.push('', '## Local Review', '');
    lines.push(`- markdown: ${task.localReview.markdownPath}`);
    lines.push(`- diff: ${task.localReview.diffPath}`);
  }

  if (task.remotePush) {
    lines.push('', '## Remote Push', '');
    if (task.remotePush.dryRunAt) lines.push(`- dry-run: ${task.remotePush.dryRunAt}`);
    if (task.remotePush.writeAt) lines.push(`- write: ${task.remotePush.writeAt}`);
    if (task.remotePush.command) lines.push(`- command: ${task.remotePush.command}`);
    if (task.remotePush.resultPath) lines.push(`- result: ${task.remotePush.resultPath}`);
  }

  if (task.cleanup.length > 0) {
    lines.push('', '## Cleanup', '');
    for (const item of task.cleanup) lines.push(`- ${item}`);
  }

  return `${lines.join('\n')}\n`;
}
