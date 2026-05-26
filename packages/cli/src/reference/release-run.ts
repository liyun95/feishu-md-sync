import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ReferenceApplyReport } from './apply.js';
import type { ReferenceAuditReport } from './audit.js';
import { buildReferencePrBody, buildReferencePrCommand, formatShellCommand, runReferencePrCommand } from './git-workflow.js';
import { runWebContentCommand, type WebContentRunResult } from './web-content.js';
import { loadReferenceReleaseWorkflowConfig } from './workflow-config.js';

export type ReferenceReleasePhaseName =
  | 'feishu-apply'
  | 'feishu-audit'
  | 'web-content-check'
  | 'web-content-pull'
  | 'pr-prepare';

export type ReferenceReleasePhaseReport = {
  name: ReferenceReleasePhaseName;
  passed: boolean;
  summary: string;
};

export type ReferenceReleaseRunReport = {
  sdk: string;
  versionRange?: string;
  passed: boolean;
  reportPath: string;
  phases: ReferenceReleasePhaseReport[];
};

export type ReferenceApplyExecutor = (options: {
  manifestPath: string;
  write: boolean;
}) => Promise<Pick<ReferenceApplyReport, 'mode' | 'failed'>>;

export type ReferenceAuditExecutor = (options: {
  manifestPath: string;
}) => Promise<Pick<ReferenceAuditReport, 'passed'>>;

export type ReferenceReleaseRunOptions = {
  configPath: string;
  writeFeishu: boolean;
  pullWebContent: boolean;
  createPr: boolean;
  applyManifest: ReferenceApplyExecutor;
  auditManifest: ReferenceAuditExecutor;
  runWebContent?: typeof runWebContentCommand;
  runPr?: typeof runReferencePrCommand;
};

export async function runReferenceReleaseWorkflow(
  options: ReferenceReleaseRunOptions
): Promise<ReferenceReleaseRunReport> {
  const config = await loadReferenceReleaseWorkflowConfig(options.configPath);
  const configDir = dirname(resolve(options.configPath));
  const reportsDir = resolve(configDir, config.reportsDir ?? 'reports');
  await mkdir(reportsDir, { recursive: true });

  const phases: ReferenceReleasePhaseReport[] = [];
  const manifestPath = resolve(configDir, config.manifest);

  const applyReport = await options.applyManifest({
    manifestPath,
    write: options.writeFeishu
  });
  phases.push({
    name: 'feishu-apply',
    passed: applyReport.failed.length === 0,
    summary: `${applyReport.mode}; failures=${applyReport.failed.length}`
  });

  const auditReport = await options.auditManifest({ manifestPath });
  phases.push({
    name: 'feishu-audit',
    passed: auditReport.passed,
    summary: auditReport.passed ? 'Feishu readback passed.' : 'Feishu readback failed.'
  });

  const webContentRunner = options.runWebContent ?? runWebContentCommand;
  const webContentConfig = {
    ...config.webContent,
    mode: options.pullWebContent ? config.webContent.mode : 'check' as const
  };
  const webContentResult: WebContentRunResult = await webContentRunner(webContentConfig);
  phases.push({
    name: webContentConfig.mode === 'pull' ? 'web-content-pull' : 'web-content-check',
    passed: webContentResult.exitCode === 0,
    summary: webContentResult.stdout.trim() || webContentResult.stderr.trim() || webContentResult.command
  });

  if (config.pr) {
    const reportPath = join(reportsDir, 'reference-release-report.json');
    const body = buildReferencePrBody({
      sdk: config.sdk,
      versionRange: config.versionRange,
      feishuReportPath: reportPath,
      webContentSummary: webContentResult.stdout,
      risks: options.pullWebContent
        ? []
        : ['web-content pull was not executed; run again with --pull-web-content after Feishu sync is complete.']
    });
    const bodyFile = config.pr.bodyFile ? resolve(config.webContent.repo, config.pr.bodyFile) : join(reportsDir, 'pr-body.md');
    await mkdir(dirname(bodyFile), { recursive: true });
    await writeFile(bodyFile, body, 'utf8');
    const prCommand = {
      base: config.pr.base,
      branch: config.pr.branch,
      title: config.pr.title ?? `Update ${config.sdk} SDK reference`,
      bodyFile
    };
    const command = buildReferencePrCommand(prCommand);
    if (options.createPr) {
      if (!phases.every((phase) => phase.passed)) {
        phases.push({
          name: 'pr-prepare',
          passed: false,
          summary: 'Skipped PR creation because an earlier workflow phase failed.'
        });
      } else {
        const prResult = await (options.runPr ?? runReferencePrCommand)(prCommand, resolve(config.webContent.repo));
        phases.push({
          name: 'pr-prepare',
          passed: prResult.exitCode === 0,
          summary: prResult.stdout.trim() || prResult.stderr.trim() || prResult.command
        });
      }
    } else {
      phases.push({
        name: 'pr-prepare',
        passed: true,
        summary: `Prepared PR command: ${formatShellCommand(command)}`
      });
    }
  }

  const reportPath = join(reportsDir, 'reference-release-report.json');
  const report: ReferenceReleaseRunReport = {
    sdk: config.sdk,
    versionRange: config.versionRange,
    passed: phases.every((phase) => phase.passed),
    reportPath,
    phases
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
