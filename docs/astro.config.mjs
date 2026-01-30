import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://egeominotti.github.io',
  base: '/bunqueue',
  integrations: [
    starlight({
      title: 'bunqueue',
      description: 'High-performance job queue for Bun. SQLite persistence, DLQ, cron jobs, S3 backups.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: {
        github: 'https://github.com/egeominotti/bunqueue',
      },
      editLink: {
        baseUrl: 'https://github.com/egeominotti/bunqueue/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', link: '/guide/introduction/' },
            { label: 'Installation', link: '/guide/installation/' },
            { label: 'Quick Start', link: '/guide/quickstart/' },
          ],
        },
        {
          label: 'Client SDK',
          items: [
            { label: 'Queue', link: '/guide/queue/' },
            { label: 'Worker', link: '/guide/worker/' },
            { label: 'Stall Detection', link: '/guide/stall-detection/' },
            { label: 'Dead Letter Queue', link: '/guide/dlq/' },
            { label: 'Flow Producer', link: '/guide/flow/' },
          ],
        },
        {
          label: 'Server Mode',
          items: [
            { label: 'Running the Server', link: '/guide/server/' },
            { label: 'CLI Commands', link: '/guide/cli/' },
            { label: 'Environment Variables', link: '/guide/env-vars/' },
            { label: 'HTTP API', link: '/api/http/' },
            { label: 'TCP Protocol', link: '/api/tcp/' },
          ],
        },
        {
          label: 'Advanced',
          items: [
            { label: 'Cron Jobs', link: '/guide/cron/' },
            { label: 'S3 Backup', link: '/guide/backup/' },
            { label: 'Rate Limiting', link: '/guide/rate-limiting/' },
            { label: 'Webhooks', link: '/guide/webhooks/' },
            { label: 'Benchmarks', link: '/guide/benchmarks/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'TypeScript Types', link: '/api/types/' },
            { label: 'Examples', link: '/examples/' },
            { label: 'Migration from BullMQ', link: '/guide/migration/' },
          ],
        },
        {
          label: 'Resources',
          items: [
            { label: 'FAQ', link: '/faq/' },
            { label: 'Troubleshooting', link: '/troubleshooting/' },
            { label: 'Changelog', link: '/changelog/' },
            { label: 'Security', link: '/security/' },
            { label: 'Contributing', link: '/contributing/' },
          ],
        },
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://egeominotti.github.io/bunqueue/og-image.png',
          },
        },
      ],
    }),
  ],
});
