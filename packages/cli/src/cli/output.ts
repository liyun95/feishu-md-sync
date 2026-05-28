export type OutputFormat = 'pretty' | 'json';

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printFormatted(value: unknown, format: string | undefined): void {
  if (format === 'json') {
    printJson(value);
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  printJson(value);
}

export function setFailedExitCode(condition: boolean): void {
  if (condition) process.exitCode = 1;
}
