export type CodeBlockConfig = {
  languageAliases: Record<string, string>;
};

export type ResolvedCodeLanguage = {
  sourceLanguage: string;
  resolvedLanguage: string;
  languageId: number;
};

const LANGUAGE_IDS = {
  plaintext: 1,
  bash: 7,
  cpp: 9,
  c: 10,
  css: 12,
  dart: 15,
  dockerfile: 18,
  erlang: 19,
  go: 22,
  groovy: 23,
  html: 24,
  http: 26,
  haskell: 27,
  json: 28,
  java: 29,
  javascript: 30,
  kotlin: 32,
  latex: 33,
  lisp: 34,
  lua: 36,
  matlab: 37,
  makefile: 38,
  markdown: 40,
  nginx: 41,
  php: 44,
  perl: 45,
  powershell: 47,
  protobuf: 48,
  python: 49,
  ruby: 52,
  rust: 53,
  scss: 55,
  scheme: 56,
  sql: 57,
  scala: 58,
  swift: 59,
  thrift: 60,
  shell: 62,
  typescript: 64,
  vb: 65,
  xml: 66,
  yaml: 67,
  cmake: 68,
  diff: 69,
  gherkin: 70,
  graphql: 71,
  properties: 73,
  solidity: 74,
  toml: 75
} as const;

const BUILT_IN_ALIASES: Record<string, string> = {
  'plain text': 'plaintext',
  text: 'plaintext',
  txt: 'plaintext',
  conf: 'plaintext',
  config: 'plaintext',
  log: 'plaintext',
  promql: 'plaintext',
  curl: 'bash',
  rest: 'bash',
  restful: 'bash',
  sh: 'shell',
  zsh: 'shell',
  cxx: 'cpp',
  golang: 'go',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  md: 'markdown',
  py: 'python',
  ps1: 'powershell',
  proto: 'protobuf',
  rs: 'rust',
  ts: 'typescript',
  visualbasic: 'vb',
  yml: 'yaml'
};

const LANGUAGE_BY_ID = new Map<number, string>(
  Object.entries(LANGUAGE_IDS).map(([language, id]) => [id, language])
);
LANGUAGE_BY_ID.set(50, 'python');

export const DEFAULT_CODE_BLOCK_CONFIG: CodeBlockConfig = {
  languageAliases: {}
};

export function resolveCodeLanguage(
  sourceLanguage: string,
  config: CodeBlockConfig = DEFAULT_CODE_BLOCK_CONFIG
): ResolvedCodeLanguage {
  const source = sourceLanguage.trim().toLowerCase() || 'plaintext';
  const chain = [source];
  let current = source;

  while (true) {
    const configured = config.languageAliases[current]?.trim().toLowerCase();
    if (!configured && current in LANGUAGE_IDS) break;
    const next = configured ?? BUILT_IN_ALIASES[current];
    if (!next) throw new Error(`unsupported Code block language: ${source}`);
    if (chain.includes(next)) {
      throw new Error(`Code block language alias cycle: ${[...chain, next].join(' -> ')}`);
    }
    chain.push(next);
    current = next;
  }

  return {
    sourceLanguage: sourceLanguage.trim().toLowerCase(),
    resolvedLanguage: current,
    languageId: LANGUAGE_IDS[current as keyof typeof LANGUAGE_IDS]
  };
}

export function codeLanguageId(language: string): number {
  return resolveCodeLanguage(language).languageId;
}

export function codeLanguageForId(id: number): string {
  const language = LANGUAGE_BY_ID.get(id);
  if (!language) throw new Error(`unsupported Feishu Code block language ID: ${id}`);
  return language;
}
