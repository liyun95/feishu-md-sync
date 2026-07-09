export function protectInlineSpans(line: string): {
  protectedLine: string;
  restore(value: string): string;
} {
  const spans: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${spans.length}\u0000`;
    spans.push(value);
    return token;
  };

  const protectedLine = line
    .replace(/<include\b[\s\S]*?<\/include>/g, protect)
    .replace(/`[^`]*`/g, protect)
    .replace(/\[[^\]]+\]\([^)]+\)/g, protect);

  return {
    protectedLine,
    restore: (value: string) => value.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? '')
  };
}

export function milvusOnly(value: string): string {
  return `<include target="milvus">${value}</include>`;
}

export function dualProductName(): string {
  return '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>';
}
