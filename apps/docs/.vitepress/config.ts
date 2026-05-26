import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE ?? '/';

export default defineConfig({
  title: 'md2feishu',
  description: 'Safe Markdown to Feishu document sync for humans and agents.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Agent Guide', link: '/agent/install' },
      { text: 'Commands', link: '/reference/commands' },
      { text: 'Internals', link: '/internals/architecture' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Agent Harness', link: '/guide/agent-harness' },
          { text: 'Multi-SDK Workflow', link: '/guide/multisdk-workflow' },
          { text: 'SDK Reference Workflow', link: '/guide/sdk-reference-workflow' },
          { text: 'SDK Reference Release', link: '/guide/sdk-reference-release-workflow' },
          { text: 'Release Workflow', link: '/guide/release-workflow' },
          { text: 'First Baseline Sync', link: '/guide/baseline-sync' },
          { text: 'Conflict Workflow', link: '/guide/conflict-workflow' },
          { text: 'Merge Workflow', link: '/guide/merge-workflow' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
      },
      {
        text: 'Agent Guide',
        items: [
          { text: 'Install For Agents', link: '/agent/install' },
          { text: 'Non-Interactive Usage', link: '/agent/non-interactive' },
          { text: 'Safe Write Policy', link: '/agent/safe-write-policy' },
          { text: 'Merge Decision Tree', link: '/agent/merge-decision-tree' },
          { text: 'Error Handling', link: '/agent/error-handling' },
          { text: 'Feishu Markdown Pull', link: '/agent/skills/feishu-markdown-pull' },
          { text: 'Feishu Markdown Push', link: '/agent/skills/feishu-markdown-push' },
          { text: 'Feishu Codeblock Writer', link: '/agent/skills/feishu-codeblock-writer' },
          { text: 'SDK Source Verifier', link: '/agent/skills/sdk-source-verifier' },
          { text: 'SDK Reference Publisher', link: '/agent/skills/sdk-reference-publisher' },
          { text: 'Milvus Multi-SDK Sync', link: '/agent/skills/milvus-multisdk-example-sync' },
          { text: 'Milvus Release Notes Workflow', link: '/agent/skills/milvus-release-notes-workflow' },
          { text: 'Skill Roadmap', link: '/agent/skill-roadmap' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/reference/commands' },
          { text: 'Sync Strategies', link: '/reference/strategies' },
          { text: 'Receipts', link: '/reference/receipts' },
          { text: 'Markdown Support', link: '/reference/markdown-support' },
          { text: 'Environment', link: '/reference/environment' }
        ]
      },
      {
        text: 'Internals',
        items: [
          { text: 'Architecture', link: '/internals/architecture' },
          { text: 'Feishu API Notes', link: '/internals/feishu-api-notes' },
          { text: 'Testing', link: '/internals/testing' },
          { text: 'Release Checklist', link: '/internals/release-checklist' }
        ]
      }
    ],
    search: {
      provider: 'local'
    },
    outline: {
      level: [2, 3]
    }
  }
});
