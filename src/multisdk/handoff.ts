import { MULTISDK_LANGUAGES } from './language.js';
import type { MultisdkTask } from './task.js';

export function renderMultisdkHandoff(task: MultisdkTask): string {
  const lines = [
    '# Multi-SDK Handoff',
    '',
    `Document: ${task.document}`,
    `Document ID: ${task.documentId}`,
    `Task dir: ${task.taskDir}`,
    `Final audit: ${task.finalAuditPassed ? 'passed' : 'not passed'}`,
    '',
    '## Languages',
    ''
  ];

  for (const language of MULTISDK_LANGUAGES) {
    const state = task.languages[language];
    lines.push(`- ${language}: ${state.status}`);
    for (const evidence of state.evidence) {
      lines.push(`  - evidence: ${evidence.path}`);
      lines.push(`  - command: ${evidence.command}`);
    }
    if (state.reason) lines.push(`  - reason: ${state.reason}`);
  }

  if (task.cleanup.length > 0) {
    lines.push('', '## Cleanup', '');
    for (const item of task.cleanup) lines.push(`- ${item}`);
  }

  return `${lines.join('\n')}\n`;
}
