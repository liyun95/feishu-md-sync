import { describe, expect, it, vi } from 'vitest';
import type { FeishuDocClient } from '../src/feishu/types.js';
import { applyPatch, planSmartPatch } from '../src/sync/patch.js';
import { planSectionPatch } from '../src/sync/section.js';

describe('patch planning', () => {
  it('plans no-op when current and desired blocks match', async () => {
    const blocks = [{ block_type: 2, text: { elements: [] } }];
    const plan = planSmartPatch(blocks, blocks);
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(),
      createChildren: vi.fn()
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', plan, blocks)).resolves.toEqual({
      deleted: 0,
      created: 0,
      skipped: true
    });
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('can replace existing blocks with an empty desired document', async () => {
    const plan = planSmartPatch([{ block_type: 2, text: { elements: [] } }], []);
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(),
      createChildren: vi.fn()
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', plan, [])).resolves.toEqual({
      deleted: 1,
      created: 0,
      skipped: false
    });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc', 'page', 0, 1);
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('creates replacement blocks before deleting existing blocks', async () => {
    const current = [{ block_type: 2, text: { elements: [] } }];
    const desired = [{ block_type: 2, text: { elements: [{ text_run: { content: 'new', text_element_style: {} } }] } }];
    const plan = planSmartPatch(current, desired);
    const callOrder: string[] = [];
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(async () => {
        callOrder.push('delete');
      }),
      createChildren: vi.fn(async () => {
        callOrder.push('create');
        return desired;
      })
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', plan, desired)).resolves.toEqual({
      deleted: 1,
      created: 1,
      skipped: false
    });
    expect(client.createChildren).toHaveBeenCalledWith('doc', 'page', desired, { index: 1 });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc', 'page', 0, 1);
    expect(callOrder).toEqual(['create', 'delete']);
  });

  it('does not delete existing blocks if replacement creation fails', async () => {
    const current = [{ block_type: 2, text: { elements: [] } }];
    const desired = [{ block_type: 2, text: { elements: [{ text_run: { content: 'new', text_element_style: {} } }] } }];
    const plan = planSmartPatch(current, desired);
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(),
      createChildren: vi.fn(async () => {
        throw new Error('schema mismatch');
      })
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', plan, desired)).rejects.toThrow(/schema mismatch/);
    expect(client.createChildren).toHaveBeenCalledWith('doc', 'page', desired, { index: 1 });
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });

  it('does not delete existing blocks if Feishu creates only part of the replacement', async () => {
    const current = [{ block_type: 2, text: { elements: [] } }];
    const desired = [
      { block_type: 2, text: { elements: [{ text_run: { content: 'one', text_element_style: {} } }] } },
      { block_type: 2, text: { elements: [{ text_run: { content: 'two', text_element_style: {} } }] } }
    ];
    const plan = planSmartPatch(current, desired);
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(),
      createChildren: vi.fn(async () => desired.slice(0, 1))
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', plan, desired)).rejects.toThrow(
      /Feishu created 1 of 2 replacement blocks; refusing to delete existing content/
    );
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });

  it('replaces only the planned section range', async () => {
    const current = [
      heading(1, 'Title'),
      heading(2, 'Target'),
      text('Old'),
      heading(2, 'Other'),
      text('Keep')
    ];
    const desired = [
      heading(1, 'Title'),
      heading(2, 'Target'),
      text('New'),
      heading(2, 'Other'),
      text('Local other')
    ];
    const section = planSectionPatch(current, desired, 'Target');
    const callOrder: string[] = [];
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(async () => {
        callOrder.push('delete');
      }),
      createChildren: vi.fn(async () => {
        callOrder.push('create');
        return section.replacementBlocks;
      })
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', section.patchPlan, section.replacementBlocks)).resolves.toEqual({
      deleted: 2,
      created: 2,
      skipped: false
    });
    expect(client.createChildren).toHaveBeenCalledWith('doc', 'page', section.replacementBlocks, { index: 3 });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc', 'page', 1, 3);
    expect(callOrder).toEqual(['create', 'delete']);
  });

  it('does not delete a section range if replacement creation fails', async () => {
    const current = [heading(2, 'Target'), text('Old'), heading(2, 'Other')];
    const desired = [heading(2, 'Target'), text('New')];
    const section = planSectionPatch(current, desired, 'Target');
    const client = {
      getDocumentBlocks: vi.fn(),
      deleteChildren: vi.fn(),
      createChildren: vi.fn(async () => {
        throw new Error('schema mismatch');
      })
    } as unknown as FeishuDocClient;

    await expect(applyPatch(client, 'doc', 'page', section.patchPlan, section.replacementBlocks)).rejects.toThrow(/schema mismatch/);
    expect(client.createChildren).toHaveBeenCalledWith('doc', 'page', section.replacementBlocks, { index: 2 });
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });
});

function heading(level: number, title: string) {
  return {
    block_type: level + 2,
    [`heading${level}`]: {
      elements: [{ text_run: { content: title, text_element_style: {} } }],
      style: { align: 1 }
    }
  };
}

function text(content: string) {
  return {
    block_type: 2,
    text: {
      elements: [{ text_run: { content, text_element_style: {} } }],
      style: { align: 1 }
    }
  };
}
