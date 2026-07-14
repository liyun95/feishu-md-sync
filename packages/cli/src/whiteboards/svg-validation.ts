import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

export type SvgValidationIssue = {
  code: 'malformed-svg' | 'missing-viewbox' | 'unsupported-element' | 'external-resource' | 'unsupported-transform';
  message: string;
};

export type SvgValidationResult = {
  valid: boolean;
  issues: SvgValidationIssue[];
  expectedTexts: string[];
};

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'line',
  'polyline',
  'path',
  'text',
  'tspan',
  'g',
  'a',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'metadata'
]);

const IMPORTABLE_ELEMENTS = new Set([
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'line',
  'polyline',
  'path',
  'text',
  'use'
]);

export function validateWhiteboardSvg(svg: string): SvgValidationResult {
  const issues: SvgValidationIssue[] = [];
  const expectedTexts: string[] = [];
  const textStack: string[] = [];
  let rootSeen = false;
  let viewBoxSeen = false;
  let importableElements = 0;

  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag: SaxesTagNS) => {
    const name = tag.local;
    if (!rootSeen) {
      rootSeen = true;
      if (name !== 'svg') addIssue(issues, 'unsupported-element', 'SVG root element must be <svg>.');
      viewBoxSeen = Boolean(attributeValue(tag, 'viewBox')?.trim());
    }

    if (!ALLOWED_ELEMENTS.has(name)) {
      addIssue(issues, 'unsupported-element', `unsupported SVG element: ${name}`);
    }
    if (IMPORTABLE_ELEMENTS.has(name)) importableElements += 1;

    for (const attribute of Object.values(tag.attributes)) {
      validateAttribute(attribute, issues);
    }
    if (name === 'text' || name === 'tspan') textStack.push('');
  });
  parser.on('text', (value: string) => {
    if (textStack.length === 0) return;
    textStack[textStack.length - 1] = `${textStack[textStack.length - 1] ?? ''}${value}`;
  });
  parser.on('closetag', (tag: SaxesTagNS) => {
    if (tag.local !== 'text' && tag.local !== 'tspan') return;
    const value = normalizeText(textStack.pop() ?? '');
    if (value) expectedTexts.push(value);
  });
  parser.on('error', (error: Error) => {
    addIssue(issues, 'malformed-svg', `malformed SVG: ${error.message}`);
  });
  parser.on('processinginstruction', (instruction) => {
    addIssue(issues, 'external-resource', `SVG processing instruction is unsupported: ${instruction.target}`);
  });

  try {
    parser.write(svg).close();
  } catch (error) {
    addIssue(issues, 'malformed-svg', `malformed SVG: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!rootSeen) addIssue(issues, 'malformed-svg', 'SVG is empty.');
  if (rootSeen && !viewBoxSeen) addIssue(issues, 'missing-viewbox', 'SVG root must declare viewBox.');
  if (rootSeen && importableElements === 0) {
    addIssue(issues, 'unsupported-element', 'SVG contains no importable editable elements.');
  }

  return {
    valid: issues.length === 0,
    issues,
    expectedTexts: [...new Set(expectedTexts)]
  };
}

function validateAttribute(attribute: SaxesAttributeNS, issues: SvgValidationIssue[]): void {
  const name = attribute.local;
  const value = attribute.value.trim();
  if (/^on/i.test(name)) {
    addIssue(issues, 'unsupported-element', `SVG script event attribute is unsupported: ${attribute.name}`);
  }
  if ((name === 'href' || attribute.name === 'xlink:href') && value && !value.startsWith('#')) {
    addIssue(issues, 'external-resource', `external SVG reference is unsupported: ${value}`);
  }
  if (/url\(\s*['"]?https?:/i.test(value)) {
    addIssue(issues, 'external-resource', `external SVG URL is unsupported in ${attribute.name}.`);
  }
  if (name === 'transform' && /\b(?:matrix|skewX|skewY)\s*\(/i.test(value)) {
    addIssue(issues, 'unsupported-transform', `unsupported SVG transform: ${value}`);
  }
}

function attributeValue(tag: SaxesTagNS, localName: string): string | undefined {
  return Object.values(tag.attributes).find((attribute) => attribute.local === localName)?.value;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function addIssue(issues: SvgValidationIssue[], code: SvgValidationIssue['code'], message: string): void {
  if (issues.some((issue) => issue.code === code && issue.message === message)) return;
  issues.push({ code, message });
}
