import { describe, expect, it } from 'vitest';
import type { FeishuBlock } from '../src/feishu/types.js';
import { analyzeRenderRisks, renderRiskSummaryLines } from '../src/sync/render-risk.js';

describe('render risk analyzer', () => {
  it('detects raw table HTML, duplicate H1, missing H2 References, and non-bold table headers', () => {
    const blocks: FeishuBlock[] = [
      heading(1, 'Regex Filter Review Tracker'),
      heading(1, 'Regex Filter Review Tracker'),
      {
        block_type: 2,
        text: { elements: [{ text_run: { content: '<table><tr><td>Raw</td></tr></table>', text_element_style: {} } }] }
      },
      {
        block_type: 31,
        table: {
          property: { row_size: 2, column_size: 2 },
          cells: [
            textCell('Area', false),
            textCell('Status', true),
            textCell('Docs', false),
            textCell('OK', false)
          ]
        }
      }
    ];

    const report = analyzeRenderRisks({
      sourceMarkdown: '<table><tr><td>Raw</td></tr></table>',
      desiredBlocks: blocks,
      remoteBlocks: blocks
    });

    expect(report.rawHtmlTableInSource).toBe(true);
    expect(report.rawHtmlTextBlockCount).toBe(1);
    expect(report.duplicateH1).toEqual(['Regex Filter Review Tracker']);
    expect(report.referencesHeadingLevel).toBe('missing');
    expect(report.tableBlockCount).toBe(1);
    expect(report.tableSummaries[0]).toMatchObject({
      rows: 2,
      columns: 2,
      headerBoldCells: 1,
      headerCellCount: 2
    });
    expect(report.risks).toEqual(expect.arrayContaining([
      'source contains raw <table> HTML',
      'remote contains raw <table>/<td> text blocks',
      'duplicate H1: Regex Filter Review Tracker',
      'missing H2 References',
      'table 1 has 1/2 bold header cells'
    ]));
  });

  it('formats concise CLI summary lines', () => {
    const report = analyzeRenderRisks({
      sourceMarkdown: '| Area | Status |\n| ---- | ------ |\n| Docs | OK |\n',
      desiredBlocks: [{
        block_type: 31,
        table: {
          property: { row_size: 2, column_size: 2 },
          cells: [
            textCell('Area', true),
            textCell('Status', true),
            textCell('Docs', false),
            textCell('OK', false)
          ]
        }
      }, heading(2, 'References')]
    });

    expect(renderRiskSummaryLines(report)).toEqual([
      'Render risks: none detected',
      'Tables: 1 Feishu table block(s)',
      '- table 1: 2 rows x 2 columns, header bold 2/2'
    ]);
  });
});

function heading(level: 1 | 2, text: string): FeishuBlock {
  return {
    block_type: level === 1 ? 3 : 4,
    [`heading${level}`]: { elements: [{ text_run: { content: text, text_element_style: {} } }] }
  };
}

function textCell(content: string, bold: boolean): FeishuBlock {
  return {
    block_type: 2,
    text: {
      elements: [{
        text_run: {
          content,
          text_element_style: { bold }
        }
      }]
    }
  };
}
