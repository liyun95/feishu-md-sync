import type { SemanticCell, SemanticInline, SemanticTable } from '../semantic/types.js';

export function renderTableXml(table: SemanticTable): string {
  if (table.unsupported.length > 0) {
    throw new Error(`Cannot render unsupported table: ${table.unsupported.join('; ')}`);
  }

  const header = `<thead><tr>${table.headers.map((cell) => `<th>${renderCell(cell)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${table.rows.map((row) => {
    return `<tr>${row.cells.map((cell) => `<td>${renderCell(cell)}</td>`).join('')}</tr>`;
  }).join('')}</tbody>`;
  return `<table>${header}${body}</table>`;
}

function renderCell(cell: SemanticCell): string {
  return cell.blocks.map((block) => {
    if (block.kind === 'paragraph') return `<p>${block.inlines.map(renderInline).join('')}</p>`;
    const tag = block.ordered ? 'ol' : 'ul';
    return `<${tag}>${block.items.map((item) => `<li>${item.map(renderInline).join('')}</li>`).join('')}</${tag}>`;
  }).join('');
}

function renderInline(inline: SemanticInline): string {
  if (inline.kind === 'break') return '<br/>';
  let rendered = escapeText(inline.value);
  if (inline.marks?.code) rendered = `<code>${rendered}</code>`;
  if (inline.marks?.italic) rendered = `<em>${rendered}</em>`;
  if (inline.marks?.bold) rendered = `<b>${rendered}</b>`;
  if (inline.marks?.link) rendered = `<a href="${escapeAttribute(inline.marks.link)}">${rendered}</a>`;
  return rendered;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
