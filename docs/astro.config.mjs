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
            { label: 'Introduction', slug: 'guide/introduction' },
            { label: 'Installation', slug: 'guide/installation' },
            { label: 'Quick Start', slug: 'guide/quickstart' },
          ],
        },
        {
          label: 'Client SDK',
          items: [
            { label: 'Queue', slug: 'guide/queue' },
            { label: 'Worker', slug: 'guide/worker' },
            { label: 'Stall Detection', slug: 'guide/stall-detection' },
            { label: 'Dead Letter Queue', slug: 'guide/dlq' },
            { label: 'Flow Producer', slug: 'guide/flow' },
          ],
        },
        {
          label: 'Server Mode',
          items: [
            { label: 'Running the Server', slug: 'guide/server' },
            { label: 'CLI Commands', slug: 'guide/cli' },
            { label: 'HTTP API', slug: 'api/http' },
            { label: 'TCP Protocol', slug: 'api/tcp' },
          ],
        },
        {
          label: 'Advanced',
          items: [
            { label: 'Cron Jobs', slug: 'guide/cron' },
            { label: 'S3 Backup', slug: 'guide/backup' },
            { label: 'Rate Limiting', slug: 'guide/rate-limiting' },
            { label: 'Webhooks', slug: 'guide/webhooks' },
          ],
        },
        {
          label: 'API Reference',
          autogenerate: { directory: 'api' },
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
