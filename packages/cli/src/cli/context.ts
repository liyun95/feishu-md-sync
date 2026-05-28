import { FeishuClient } from '../feishu/client.js';
import type { CliEnvLoadReport } from './env.js';

export type CliContext = {
  envLoadReport: CliEnvLoadReport;
  createFeishuClient(input?: { host?: string; timeoutMs?: number }): FeishuClient;
};

export function createCliContext(envLoadReport: CliEnvLoadReport): CliContext {
  return {
    envLoadReport,
    createFeishuClient: (input = {}) => new FeishuClient({
      host: input.host,
      timeoutMs: input.timeoutMs
    })
  };
}
