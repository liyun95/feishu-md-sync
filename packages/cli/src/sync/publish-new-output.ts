import type { PublishNewDestination, PublishNewPlan } from './publish-new-plan.js';
import type { PublishNewRunResult } from './publish-new.js';

export function publishNewSummaryLines(result: PublishNewRunResult): string[] {
  if (result.mode === 'write') return writeLines(result);

  const plan = result.plan;
  const lines = [
    'Intent: publish local Markdown to a new Feishu document',
    `Title: ${plan.title}`,
    `Title source: ${plan.titleSource}`,
    `Source: ${plan.sourcePath}`,
    `Destination: ${formatDestination(plan.destination)}`,
    `Destination source: ${formatDestinationSource(plan.destination)}`,
    `Creation strategy: ${plan.creationStrategy}`,
    `Staging folder: ${formatStagingFolder(plan.destination)}`,
    `Final document type: ${plan.destination.kind === 'wiki' ? 'docx in wiki' : plan.destination.kind === 'folder' ? 'docx in Drive folder' : 'app-owned docx'}`,
    `Wiki move: ${plan.destination.kind === 'wiki' ? 'yes' : 'no'}`,
    `Duplicate title check: ${plan.duplicateCandidates.length === 0 ? 'passed' : 'blocked'}`,
    'Mode: dry-run, no Feishu document will be created',
    `Receipt: ${plan.receiptPath} after write verification`,
    '',
    'Planned Feishu changes:',
    '- create 1 docx document',
    `- create ${plan.creates.blocks} docx child blocks`
  ];

  if (plan.destination.kind === 'wiki') {
    lines.push(`- move document to wiki parent ${plan.destination.parentNodeToken}`);
  }
  lines.push('- pull readback for verification', '', 'Run with --write to publish.');

  return lines;
}

function writeLines(result: PublishNewRunResult): string[] {
  const url = result.document?.publishedUrl ?? result.document?.docxUrl ?? '<unknown-url>';
  return [
    'Intent: publish local Markdown to a new Feishu document',
    `Title: ${result.plan.title}`,
    `Source: ${result.plan.sourcePath}`,
    `Published: ${url}`,
    `Receipt: ${result.receiptPath}`,
    `Verification: ${result.verification.ok ? 'passed' : 'failed'}`,
    '',
    `Next update command:\nmd2feishu push ${result.plan.sourcePath} '${url}'`
  ];
}

function formatDestination(destination: PublishNewDestination): string {
  if (destination.kind === 'app-owned') return 'app-owned docx';
  if (destination.kind === 'folder') return `folder ${destination.folderToken}`;
  return `wiki parent ${destination.parentNodeToken} in space ${destination.spaceId}`;
}

function formatDestinationSource(destination: PublishNewDestination): string {
  if (destination.kind === 'app-owned') return destination.source;
  if (destination.kind === 'folder') return destination.source;
  return `${destination.spaceSource} + ${destination.parentSource}`;
}

function formatStagingFolder(destination: PublishNewDestination): string {
  if (destination.kind === 'app-owned') return 'not used';
  return destination.folderToken;
}

export function publishNewJson(result: PublishNewRunResult): string {
  return JSON.stringify(result, null, 2);
}

export function publishNewHelpAfter(): string {
  return [
    '',
    'Common usage:',
    '  md2feishu publish-new <doc.md>',
    '  md2feishu publish-new <doc.md> --title "Doc Title"',
    '  md2feishu publish-new <doc.md> --title "Doc Title" --wiki-space-id <space-id> --wiki-parent <node-token>',
    '  md2feishu publish-new <doc.md> --title "Doc Title" --folder-token <folder-token>',
    '  md2feishu publish-new <doc.md> --title "Doc Title" --app-owned',
    '',
    'Default: dry-run. Add --write to create the Feishu document.'
  ].join('\n');
}
