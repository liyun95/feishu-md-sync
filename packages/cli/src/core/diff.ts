export function unifiedDiff(leftName: string, rightName: string, left: string, right: string): string {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const max = Math.max(leftLines.length, rightLines.length);
  const lines = [`--- ${leftName}`, `+++ ${rightName}`];

  for (let index = 0; index < max; index += 1) {
    const a = leftLines[index];
    const b = rightLines[index];

    if (a === b) {
      if (a !== undefined) lines.push(` ${a}`);
      continue;
    }

    if (a !== undefined) lines.push(`-${a}`);
    if (b !== undefined) lines.push(`+${b}`);
  }

  return `${lines.join('\n')}\n`;
}
