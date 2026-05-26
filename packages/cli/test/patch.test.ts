import { describe, expect, it, vi } from 'vitest';
import type { FeishuDocClient } from '../src/feishu/types.js';
import { applyPatch, planSmartPatch } from '../src/sync/patch.js';

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
});
