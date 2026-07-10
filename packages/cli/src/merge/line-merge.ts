export type MergeState = 'clean' | 'merged' | 'conflict';

export type LineMergeResult = {
  markdown: string;
  state: MergeState;
  conflicts: number;
  changed: boolean;
};

export type LineChange = {
  baseStart: number;
  baseEnd: number;
  lines: string[];
};

export function mergeLines(input: { base: string; local: string; remote: string }): LineMergeResult {
  if (input.local === input.remote) {
    return cleanResult(input.local);
  }

  const base = splitLines(input.base);
  const localChanges = changesFromBase(base, splitLines(input.local));
  const remoteChanges = changesFromBase(base, splitLines(input.remote));
  const output: string[] = [];
  let baseIndex = 0;
  let localIndex = 0;
  let remoteIndex = 0;
  let conflicts = 0;

  while (baseIndex < base.length || localIndex < localChanges.length || remoteIndex < remoteChanges.length) {
    const localChange = localChanges[localIndex];
    const remoteChange = remoteChanges[remoteIndex];
    if (!localChange && !remoteChange) {
      output.push(...base.slice(baseIndex));
      break;
    }

    const nextStart = Math.min(
      localChange?.baseStart ?? Number.POSITIVE_INFINITY,
      remoteChange?.baseStart ?? Number.POSITIVE_INFINITY
    );
    output.push(...base.slice(baseIndex, nextStart));
    baseIndex = nextStart;

    if (localChange && (!remoteChange || isStrictlyBefore(localChange, remoteChange))) {
      output.push(...localChange.lines);
      baseIndex = localChange.baseEnd;
      localIndex += 1;
      continue;
    }

    if (remoteChange && (!localChange || isStrictlyBefore(remoteChange, localChange))) {
      output.push(...remoteChange.lines);
      baseIndex = remoteChange.baseEnd;
      remoteIndex += 1;
      continue;
    }

    const overlap = collectOverlappingChanges({
      localChanges,
      remoteChanges,
      localIndex,
      remoteIndex
    });
    localIndex = overlap.localIndex;
    remoteIndex = overlap.remoteIndex;
    baseIndex = overlap.baseEnd;

    const localLines = applyChangesToBaseSlice(base, overlap.baseStart, overlap.baseEnd, overlap.local);
    const remoteLines = applyChangesToBaseSlice(base, overlap.baseStart, overlap.baseEnd, overlap.remote);
    if (joinLines(localLines) === joinLines(remoteLines)) {
      output.push(...localLines);
      continue;
    }

    output.push(...conflictLines(localLines, remoteLines));
    conflicts += 1;
  }

  return resultFromOutput(output, input.local, conflicts);
}

export function mergeWithoutBase(input: { local: string; remote: string }): LineMergeResult {
  if (input.local === input.remote) {
    return cleanResult(input.local);
  }

  const local = splitLines(input.local);
  const remote = splitLines(input.remote);
  const table = lcsTable(local, remote);
  const output: string[] = [];
  let i = 0;
  let j = 0;
  let conflicts = 0;

  while (i < local.length || j < remote.length) {
    if (i < local.length && j < remote.length && local[i] === remote[j]) {
      output.push(local[i]);
      i += 1;
      j += 1;
      continue;
    }

    const localChunk: string[] = [];
    const remoteChunk: string[] = [];
    while (i < local.length || j < remote.length) {
      if (i < local.length && j < remote.length && local[i] === remote[j]) break;
      if (i < local.length && (j === remote.length || table[i + 1][j] >= table[i][j + 1])) {
        localChunk.push(local[i]);
        i += 1;
        continue;
      }
      if (j < remote.length) {
        remoteChunk.push(remote[j]);
        j += 1;
      }
    }

    output.push(...conflictLines(localChunk, remoteChunk));
    conflicts += 1;
  }

  return {
    markdown: joinLines(output),
    state: 'conflict',
    conflicts,
    changed: true
  };
}

function cleanResult(markdown: string): LineMergeResult {
  return {
    markdown,
    state: 'clean',
    conflicts: 0,
    changed: false
  };
}

function resultFromOutput(output: string[], local: string, conflicts: number): LineMergeResult {
  const markdown = joinLines(output);
  if (conflicts > 0) {
    return {
      markdown,
      state: 'conflict',
      conflicts,
      changed: markdown !== local
    };
  }

  return {
    markdown,
    state: markdown === local ? 'clean' : 'merged',
    conflicts: 0,
    changed: markdown !== local
  };
}

function splitLines(markdown: string): string[] {
  return markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function joinLines(lines: string[]): string {
  return lines.join('');
}

function conflictLines(local: string[], remote: string[]): string[] {
  return [
    '<<<<<<< LOCAL\n',
    ...ensureTrailingNewline(local),
    '=======\n',
    ...ensureTrailingNewline(remote),
    '>>>>>>> REMOTE\n'
  ];
}

function ensureTrailingNewline(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const last = lines.at(-1);
  if (last?.endsWith('\n')) return lines;
  return [...lines.slice(0, -1), `${last}\n`];
}

function isStrictlyBefore(left: LineChange, right: LineChange): boolean {
  if (left.baseStart === right.baseStart) return false;
  return left.baseEnd <= right.baseStart;
}

function collectOverlappingChanges(input: {
  localChanges: LineChange[];
  remoteChanges: LineChange[];
  localIndex: number;
  remoteIndex: number;
}): {
  baseStart: number;
  baseEnd: number;
  local: LineChange[];
  remote: LineChange[];
  localIndex: number;
  remoteIndex: number;
} {
  const firstLocal = input.localChanges[input.localIndex];
  const firstRemote = input.remoteChanges[input.remoteIndex];
  let baseStart = Math.min(firstLocal?.baseStart ?? Number.POSITIVE_INFINITY, firstRemote?.baseStart ?? Number.POSITIVE_INFINITY);
  let baseEnd = Math.max(firstLocal?.baseEnd ?? baseStart, firstRemote?.baseEnd ?? baseStart);
  let localIndex = input.localIndex;
  let remoteIndex = input.remoteIndex;
  const local: LineChange[] = [];
  const remote: LineChange[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    while (localIndex < input.localChanges.length && input.localChanges[localIndex].baseStart <= baseEnd) {
      const change = input.localChanges[localIndex];
      local.push(change);
      baseStart = Math.min(baseStart, change.baseStart);
      baseEnd = Math.max(baseEnd, change.baseEnd);
      localIndex += 1;
      changed = true;
    }
    while (remoteIndex < input.remoteChanges.length && input.remoteChanges[remoteIndex].baseStart <= baseEnd) {
      const change = input.remoteChanges[remoteIndex];
      remote.push(change);
      baseStart = Math.min(baseStart, change.baseStart);
      baseEnd = Math.max(baseEnd, change.baseEnd);
      remoteIndex += 1;
      changed = true;
    }
  }

  return {
    baseStart,
    baseEnd,
    local,
    remote,
    localIndex,
    remoteIndex
  };
}

function applyChangesToBaseSlice(base: string[], start: number, end: number, changes: LineChange[]): string[] {
  const output: string[] = [];
  let index = start;
  for (const change of changes) {
    output.push(...base.slice(index, change.baseStart));
    output.push(...change.lines);
    index = change.baseEnd;
  }
  output.push(...base.slice(index, end));
  return output;
}

function changesFromBase(base: string[], next: string[]): LineChange[] {
  const table = lcsTable(base, next);
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  let pendingStart: number | undefined;
  let pendingEnd = 0;
  let pendingLines: string[] = [];

  const startPending = () => {
    if (pendingStart !== undefined) return;
    pendingStart = i;
    pendingEnd = i;
  };

  const flush = () => {
    if (pendingStart === undefined) return;
    changes.push({
      baseStart: pendingStart,
      baseEnd: pendingEnd,
      lines: pendingLines
    });
    pendingStart = undefined;
    pendingEnd = 0;
    pendingLines = [];
  };

  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && base[i] === next[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }

    startPending();
    if (j < next.length && (i === base.length || table[i][j + 1] >= table[i + 1][j])) {
      pendingLines.push(next[j]);
      j += 1;
      continue;
    }

    if (i < base.length) {
      i += 1;
      pendingEnd = i;
    }
  }

  flush();
  return changes;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}
