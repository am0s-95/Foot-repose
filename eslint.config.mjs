import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['tools/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // ---- modular monolith boundaries (mirrored by tools/boundaries.test.ts) ----
  {
    files: ['apps/branch/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}', 'apps/customer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@foot-repose/db', message: 'Frontends go through the API — never the database.' },
            { name: 'pg', message: 'Frontends go through the API — never the database.' },
            { name: 'bcryptjs', message: 'Server-only module — not allowed in frontends.' },
            { name: 'jose', message: 'Server-only module — not allowed in frontends.' },
          ],
          patterns: [
            { group: ['@foot-repose/db/*'], message: 'Frontends go through the API — never the database.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@foot-repose/*', 'pg', 'zod', 'next', 'next/*', 'react', 'react-dom'],
              message: 'domain is pure business logic — no workspace or runtime dependencies.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@foot-repose/db', message: 'contracts may depend on domain and zod only.' },
            { name: 'pg', message: 'contracts may depend on domain and zod only.' },
          ],
          patterns: [
            { group: ['@foot-repose/db/*'], message: 'contracts may depend on domain and zod only.' },
          ],
        },
      ],
    },
  },
];
