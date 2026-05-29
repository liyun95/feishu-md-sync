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
      { text: 'Workflows', link: '/guide/workflows' },
      { text: 'Reference', link: '/reference/commands' }
    ],
    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
      },
      {
        text: 'Workflows',
        items: [
          { text: 'Choose a Workflow', link: '/guide/workflows' },
          { text: 'Baseline Sync', link: '/guide/baseline-sync' },
          { text: 'Feishu Push', link: '/guide/push' },
          { text: 'Multi-SDK Examples', link: '/guide/multisdk-workflow' },
          { text: 'SDK Reference Authoring', link: '/guide/sdk-reference-workflow' },
          { text: 'SDK Reference Release', link: '/guide/sdk-reference-release-workflow' },
          { text: 'Release Notes', link: '/guide/release-workflow' }
        ]
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Safety Gates', link: '/reference/safety-gates' },
          { text: 'Receipts', link: '/reference/receipts' },
          { text: 'Sync Strategies', link: '/reference/strategies' },
          { text: 'Markdown Support', link: '/reference/markdown-support' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/reference/commands' },
          { text: 'Environment', link: '/reference/environment' }
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
