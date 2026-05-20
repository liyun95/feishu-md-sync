import path from 'node:path';

export type MergeInput = {
  base: string;
  local: string;
  remote: string;
};

export type MergeResult = {
  content: string;
  clean: boolean;
  conflictCount: number;
};

export type MergeInstructionsInput = {
  clean: boolean;
  outputPath: string;
  conflictCount: number;
  documentRef: string;
};

export function threeWayMerge(input: MergeInput): MergeResult {
  if (input.local === input.remote) {
    return { content: input.local, clean: true, conflictCount: 0 };
  }
  if (input.local === input.base) {
    return { content: input.remote, clean: true, conflictCount: 0 };
  }
  if (input.remote === input.base) {
    return { content: input.local, clean: true, conflictCount: 0 };
  }

  const baseLines = splitLines(input.base);
  const localLines = splitLines(input.local);
  const remoteLines = splitLines(input.remote);
  const max = Math.max(baseLines.length, localLines.length, remoteLines.length);
  const merged: string[] = [];
  let conflictCount = 0;

  for (let index = 0; index < max; index += 1) {
    const base = baseLines[index] ?? '';
    const local = localLines[index] ?? '';
    const remote = remoteLines[index] ?? '';

    if (local === remote) {
      merged.push(local);
      continue;
    }
    if (local === base) {
      merged.push(remote);
      continue;
    }
    if (remote === base) {
      merged.push(local);
      continue;
    }

    conflictCount += 1;
    merged.push(conflictBlock(`${local}\n`, `${base}\n`, `${remote}\n`).replace(/\n$/, ''));
  }

  return {
    content: `${merged.join('\n')}\n`,
    clean: conflictCount === 0,
    conflictCount
  };
}

export function defaultMergedPath(localPath: string): string {
  const parsed = path.parse(localPath);
  return path.join(parsed.dir, `${parsed.name}.merged${parsed.ext || '.md'}`);
}

export function buildMergeInstructions(input: MergeInstructionsInput): string {
  const status = input.clean ? 'clean' : 'conflicts';
  const lines = [
    `merge: ${status}`,
    `output: ${input.outputPath}`,
    `conflicts: ${input.conflictCount}`,
    ''
  ];

  if (!input.clean) {
    lines.push(
      'Resolve conflict markers in:',
      `  ${input.outputPath}`,
      ''
    );
  }

  lines.push(
    input.clean ? 'Next:' : 'Then run:',
    `  md2feishu sync ${input.outputPath} ${input.documentRef} --write --yes --strategy local-wins`
  );

  return `${lines.join('\n')}\n`;
}

function conflictBlock(local: string, base: string, remote: string): string {
  return [
    '<<<<<<< LOCAL',
    trimFinalNewline(local),
    '||||||| BASE',
    trimFinalNewline(base),
    '=======',
    trimFinalNewline(remote),
    '>>>>>>> FEISHU',
    ''
  ].join('\n');
}

function splitLines(value: string): string[] {
  const withoutFinalNewline = value.replace(/\n$/, '');
  return withoutFinalNewline === '' ? [] : withoutFinalNewline.split('\n');
}

function trimFinalNewline(value: string): string {
  return value.replace(/\n$/, '');
}
