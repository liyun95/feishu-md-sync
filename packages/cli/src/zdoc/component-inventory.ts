import type { DialectDiagnostic } from '../dialects/types.js';
import { parseLeadingFrontmatter } from '../dialects/frontmatter.js';
import {
  isProtectedOffset,
  protectedCodeRanges
} from '../dialects/source-lines.js';
import type {
  ZdocAdmonitionComponent,
  ZdocComponentInventory
} from './types.js';

export function inventoryAndTransformZdoc(input: {
  sourcePath: string;
  markdown: string;
  lineOffset: number;
}): {
  markdown: string;
  inventory: ZdocComponentInventory;
  blockers: DialectDiagnostic[];
} {
  const frontmatter = parseLeadingFrontmatter(input.markdown);
  const inventory: ZdocComponentInventory = {
    components: [],
    ignoredMetadata: []
  };
  const blockers: DialectDiagnostic[] = [];
  if (frontmatter.raw) {
    inventory.ignoredMetadata.push({
      kind: 'frontmatter',
      sourceLine: input.lineOffset + 1
    });
  }

  const markdown = frontmatter.body;
  const lineOffset = input.lineOffset + frontmatter.bodyStartLine - 1;
  const ranges = protectedCodeRanges(markdown);
  const lines = lineSlices(markdown);
  const output: string[] = [];
  const sectionPath: string[] = [];
  const proceduresStack: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const sourceLine = lineOffset + index + 1;
    const body = line.text.replace(/\r?\n$/, '');
    const newline = line.text.slice(body.length);

    if (isProtectedOffset(line.start, ranges)) {
      output.push(line.text);
      continue;
    }

    const heading = body.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      const title = heading[2]
        .replace(/[ \t]*\\?\{#[A-Za-z0-9_-]+\}[ \t]*$/, '')
        .trim();
      sectionPath.splice(level - 1);
      sectionPath[level - 1] = title;
      if (title !== heading[2].trim()) {
        inventory.ignoredMetadata.push({ kind: 'heading-anchor', sourceLine });
        output.push(`${heading[1]} ${title}${newline}`);
      } else {
        output.push(line.text);
      }
      continue;
    }

    if (/^ {0,3}(?:import|export)\b.*$/.test(body)) {
      inventory.ignoredMetadata.push({ kind: 'import', sourceLine });
      if (/^\r?\n$/.test(output.at(-1) ?? '')) output.pop();
      continue;
    }

    if (/^ {0,3}<Procedures>\s*$/.test(body)) {
      const status = proceduresStack.length === 0 ? 'preserved' : 'blocking';
      inventory.components.push({
        kind: 'procedures',
        token: 'open',
        status,
        sourceLine,
        sectionPath: compactSectionPath(sectionPath)
      });
      if (proceduresStack.length > 0) {
        blockers.push(diagnostic(
          'zdoc-procedures-nested',
          'Nested <Procedures> tokens are not supported.',
          input.sourcePath,
          sourceLine
        ));
      }
      proceduresStack.push(sourceLine);
      output.push(line.text);
      continue;
    }

    if (/^ {0,3}<\/Procedures>\s*$/.test(body)) {
      const matched = proceduresStack.length > 0;
      inventory.components.push({
        kind: 'procedures',
        token: 'close',
        status: matched ? 'preserved' : 'blocking',
        sourceLine,
        sectionPath: compactSectionPath(sectionPath)
      });
      if (!matched) {
        blockers.push(diagnostic(
          'zdoc-procedures-unpaired',
          'Closing </Procedures> has no matching opening token.',
          input.sourcePath,
          sourceLine
        ));
      } else {
        proceduresStack.pop();
      }
      output.push(line.text);
      continue;
    }

    const supademo = body.match(/^ {0,3}<Supademo\b([^>]*)\/\>\s*$/);
    if (supademo) {
      const attributes = parseAttributes(supademo[1] ?? '');
      const componentId = attributes.values.id;
      if (!attributes.valid || !componentId) {
        blockers.push(diagnostic(
          'zdoc-component-unsupported',
          'Supademo requires a quoted id and supports only id and title attributes.',
          input.sourcePath,
          sourceLine
        ));
        inventory.components.push({
          kind: 'unknown',
          componentName: 'Supademo',
          status: 'blocking',
          sourceLine,
          sectionPath: compactSectionPath(sectionPath)
        });
        output.push(line.text);
        continue;
      }
      inventory.components.push({
        kind: 'supademo',
        componentId,
        status: 'preserved',
        sourceLine,
        sectionPath: compactSectionPath(sectionPath)
      });
      output.push(`<readonly-block type="isv"></readonly-block>${newline}`);
      continue;
    }

    const admonition = body.match(/^ {0,3}<Admonition\b([^>]*)>\s*$/);
    if (admonition) {
      const closingIndex = findAdmonitionClose(lines, ranges, index + 1);
      const parsed = parseAdmonition(admonition[1] ?? '');
      const unsupportedChild = closingIndex === -1
        ? undefined
        : firstUppercaseComponent(lines, ranges, index + 1, closingIndex);
      if (!parsed || closingIndex === -1 || unsupportedChild) {
        const reason = closingIndex === -1
          ? 'Admonition has no closing </Admonition> tag.'
          : unsupportedChild
            ? `Admonition child <${unsupportedChild}> is not supported.`
            : 'Admonition attributes or type are not supported.';
        blockers.push(diagnostic(
          'zdoc-admonition-unsupported',
          reason,
          input.sourcePath,
          sourceLine
        ));
        if (parsed) {
          inventory.components.push({
            ...parsed,
            status: 'blocking',
            sourceLine,
            sectionPath: compactSectionPath(sectionPath)
          });
        }
        output.push(line.text);
        continue;
      }

      inventory.components.push({
        ...parsed,
        status: 'transformed',
        sourceLine,
        sectionPath: compactSectionPath(sectionPath)
      });
      output.push(
        `<div class="alert ${parsed.calloutType}" data-fms-callout-title="${escapeHtmlAttribute(parsed.title)}">${newline}`
      );
      for (let child = index + 1; child < closingIndex; child += 1) {
        output.push(lines[child]?.text ?? '');
      }
      const closing = lines[closingIndex];
      const closingBody = closing?.text.replace(/\r?\n$/, '') ?? '';
      output.push(`</div>${closing?.text.slice(closingBody.length) ?? ''}`);
      index = closingIndex;
      continue;
    }

    const unknown = body.match(/<(?!\/)([A-Z][A-Za-z0-9.]*)\b/);
    if (unknown?.[1] && !REGISTERED_COMPONENTS.has(unknown[1])) {
      inventory.components.push({
        kind: 'unknown',
        componentName: unknown[1],
        status: 'blocking',
        sourceLine,
        sectionPath: compactSectionPath(sectionPath)
      });
      blockers.push(diagnostic(
        'zdoc-component-unsupported',
        `Unsupported Zdoc component <${unknown[1]}>.`,
        input.sourcePath,
        sourceLine
      ));
    }
    output.push(line.text);
  }

  for (const sourceLine of proceduresStack) {
    blockers.push(diagnostic(
      'zdoc-procedures-unpaired',
      'Opening <Procedures> has no matching closing token.',
      input.sourcePath,
      sourceLine
    ));
    const component = inventory.components.find((candidate) =>
      candidate.kind === 'procedures'
      && candidate.token === 'open'
      && candidate.sourceLine === sourceLine
    );
    if (component) component.status = 'blocking';
  }

  return {
    markdown: output.join(''),
    inventory,
    blockers
  };
}

const REGISTERED_COMPONENTS = new Set(['Admonition', 'Procedures', 'Supademo']);

function parseAdmonition(rawAttributes: string): Pick<
  ZdocAdmonitionComponent,
  'kind' | 'title' | 'calloutType'
> | undefined {
  const attributes = parseAttributes(rawAttributes);
  if (!attributes.valid) return undefined;
  if (Object.keys(attributes.values).some((key) =>
    key !== 'type' && key !== 'icon' && key !== 'title'
  )) return undefined;
  const title = attributes.values.title;
  const type = attributes.values.type;
  if (!title) return undefined;
  const calloutType = type === 'info' || type === 'note'
    ? 'note'
    : type === 'warning'
      ? 'warning'
      : undefined;
  if (!calloutType) return undefined;
  return { kind: 'admonition', title, calloutType };
}

function parseAttributes(raw: string): {
  valid: boolean;
  values: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let consumed = '';
  for (const match of raw.matchAll(pattern)) {
    const key = match[1];
    if (!key || key in values) return { valid: false, values };
    values[key] = match[2] ?? match[3] ?? '';
    consumed += match[0];
  }
  const compactRaw = raw.replace(/\s/g, '');
  const compactConsumed = consumed.replace(/\s/g, '');
  return { valid: compactRaw === compactConsumed, values };
}

function findAdmonitionClose(
  lines: LineSlice[],
  ranges: ReturnType<typeof protectedCodeRanges>,
  startIndex: number
): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || isProtectedOffset(line.start, ranges)) continue;
    if (/^ {0,3}<\/Admonition>\s*$/.test(line.text.replace(/\r?\n$/, ''))) {
      return index;
    }
  }
  return -1;
}

function firstUppercaseComponent(
  lines: LineSlice[],
  ranges: ReturnType<typeof protectedCodeRanges>,
  startIndex: number,
  endIndex: number
): string | undefined {
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (!line || isProtectedOffset(line.start, ranges)) continue;
    const match = line.text.match(/<\/?([A-Z][A-Za-z0-9.]*)\b/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function diagnostic(
  code: 'zdoc-procedures-unpaired'
    | 'zdoc-procedures-nested'
    | 'zdoc-admonition-unsupported'
    | 'zdoc-component-unsupported',
  message: string,
  file: string,
  line: number
): DialectDiagnostic {
  return {
    code,
    severity: 'blocker',
    message,
    location: { file, line, column: 1 }
  };
}

function compactSectionPath(sectionPath: string[]): string[] {
  return sectionPath.filter(Boolean);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

type LineSlice = { text: string; start: number };

function lineSlices(markdown: string): LineSlice[] {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  return lines.map((text) => {
    const start = offset;
    offset += text.length;
    return { text, start };
  });
}
