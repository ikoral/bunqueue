import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://egeominotti.github.io',
  base: '/bunqueue',

  // Performance optimizations
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            search: ['@pagefind/default-ui'],
          },
        },
      },
    },
  },

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
      expressiveCode: {
        themes: ['github-light', 'github-dark'],
        styleOverrides: {
          borderRadius: '8px',
          borderColor: '#e4e4e7',
        },
      },
      customCss: [
        '@fontsource/inter/400.css',
        '@fontsource/inter/500.css',
        '@fontsource/inter/600.css',
        '@fontsource/inter/700.css',
        './src/styles/custom.css',
      ],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
      },
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
            { label: 'bunqueue vs BullMQ', link: '/guide/comparison/' },
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
        // Primary Meta Tags
        {
          tag: 'meta',
          attrs: {
            name: 'keywords',
            content: 'bun, job queue, message queue, task queue, background jobs, sqlite, redis alternative, bullmq alternative, typescript, cron, scheduler, worker, dlq, dead letter queue',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'author',
            content: 'egeominotti',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'robots',
            content: 'index, follow',
          },
        },
        // Open Graph / Facebook
        {
          tag: 'meta',
          attrs: {
            property: 'og:type',
            content: 'website',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:site_name',
            content: 'bunqueue',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://egeominotti.github.io/bunqueue/og-image.png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:width',
            content: '1200',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:height',
            content: '630',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:locale',
            content: 'en_US',
          },
        },
        // Twitter
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:card',
            content: 'summary_large_image',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: 'https://egeominotti.github.io/bunqueue/og-image.png',
          },
        },
        // JSON-LD Structured Data
        {
          tag: 'script',
          attrs: {
            type: 'application/ld+json',
          },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'bunqueue',
            description: 'High-performance job queue for Bun. SQLite persistence, DLQ, cron jobs, S3 backups.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Cross-platform',
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
            },
            author: {
              '@type': 'Person',
              name: 'egeominotti',
              url: 'https://github.com/egeominotti',
            },
            codeRepository: 'https://github.com/egeominotti/bunqueue',
            programmingLanguage: 'TypeScript',
            runtimePlatform: 'Bun',
          }),
        },
        // Canonical will be auto-generated by Starlight
        // Theme color for mobile browsers
        {
          tag: 'meta',
          attrs: {
            name: 'theme-color',
            content: '#ec4899',
          },
        },
        // Apple touch icon
        {
          tag: 'link',
          attrs: {
            rel: 'apple-touch-icon',
            href: '/bunqueue/apple-touch-icon.png',
          },
        },
        // DNS prefetch for external resources
        {
          tag: 'link',
          attrs: {
            rel: 'dns-prefetch',
            href: 'https://github.com',
          },
        },
        // Preconnect to GitHub
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://github.com',
          },
        },
      ],
      // Disable last updated (reduces build time)
      lastUpdated: false,
      // Pagination enabled for better UX
      pagination: true,
      // Table of contents depth
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    }),
  ],
});
