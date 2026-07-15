import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE ?? '/';

export default defineConfig({
  title: 'feishu-md-sync',
  description: 'Markdown sync bridge for local authoring and Feishu/Lark online documents.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Reference', link: '/reference/commands' }
    ],
    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Agent Usage', link: '/guide/agent-usage' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Safety Gates', link: '/reference/safety-gates' },
          { text: 'Receipts', link: '/reference/receipts' },
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
