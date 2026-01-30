import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

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
          ],
        },
        {
          label: 'Integrations',
          items: [
            { label: 'Hono & Elysia', link: '/guide/integrations/' },
            { label: 'MCP Server (AI)', link: '/guide/mcp/' },
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
            content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'googlebot',
            content: 'index, follow',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'bingbot',
            content: 'index, follow',
          },
        },
        // Open Graph / Facebook
        {
          tag: 'meta',
          attrs: {
            property: 'og:title',
            content: 'bunqueue - High-Performance Job Queue for Bun',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:description',
            content: 'SQLite persistence, cron jobs, priorities, DLQ, S3 backups. BullMQ-compatible API with zero Redis dependency.',
          },
        },
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
        {
          tag: 'meta',
          attrs: {
            property: 'og:url',
            content: 'https://egeominotti.github.io/bunqueue/',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'bunqueue - High-performance job queue for Bun with SQLite persistence',
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
            name: 'twitter:title',
            content: 'bunqueue - High-Performance Job Queue for Bun',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:description',
            content: 'SQLite persistence, cron jobs, priorities, DLQ, S3 backups. BullMQ-compatible API.',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: 'https://egeominotti.github.io/bunqueue/og-image.png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:creator',
            content: '@egeominotti',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:site',
            content: '@egeominotti',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image:alt',
            content: 'bunqueue - High-performance job queue for Bun',
          },
        },
        // JSON-LD Structured Data - SoftwareApplication
        {
          tag: 'script',
          attrs: {
            type: 'application/ld+json',
          },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'bunqueue',
            alternateName: 'bunQ',
            description: 'High-performance job queue for Bun. SQLite persistence, DLQ, cron jobs, S3 backups. 32x faster than BullMQ.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Cross-platform',
            softwareVersion: '1.6.3',
            datePublished: '2024-01-01',
            dateModified: '2025-01-30',
            license: 'https://opensource.org/licenses/MIT',
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
            publisher: {
              '@type': 'Person',
              name: 'egeominotti',
            },
            codeRepository: 'https://github.com/egeominotti/bunqueue',
            downloadUrl: 'https://www.npmjs.com/package/bunqueue',
            installUrl: 'https://www.npmjs.com/package/bunqueue',
            programmingLanguage: ['TypeScript', 'JavaScript'],
            runtimePlatform: 'Bun',
            keywords: ['job queue', 'message queue', 'bun', 'sqlite', 'typescript', 'bullmq alternative'],
            aggregateRating: {
              '@type': 'AggregateRating',
              ratingValue: '5',
              ratingCount: '1',
            },
          }),
        },
        // JSON-LD Structured Data - WebSite
        {
          tag: 'script',
          attrs: {
            type: 'application/ld+json',
          },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'bunqueue Documentation',
            url: 'https://egeominotti.github.io/bunqueue/',
            description: 'Official documentation for bunqueue - High-performance job queue for Bun',
            potentialAction: {
              '@type': 'SearchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: 'https://egeominotti.github.io/bunqueue/?search={search_term_string}',
              },
              'query-input': 'required name=search_term_string',
            },
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
    sitemap(),
  ],
});
