import type { Config } from 'jest';
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

// Component tests opt into jsdom per file with a `@jest-environment jsdom` docblock.
const config: Config = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  modulePathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/dist/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@ee/(.*)$': '<rootDir>/ee/$1',
    // No request scope in tests: a cookie jar stands in for the browser (test/next-headers.ts).
    '^next/headers(\.js)?$': '<rootDir>/test/next-headers.ts',
    // Nor a page cache to revalidate.
    '^next/cache(\.js)?$': '<rootDir>/test/next-cache.ts',
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};

// next/jest sets transformIgnorePatterns itself, so the ES-module-only packages are let through afterwards.
const esmOnly = [
  'better-auth',
  '@better-auth',
  'better-call',
  '@better-fetch',
  '@noble',
  'jose',
  'nanostores',
  'rou3',
  'defu',
  'kysely',
  'next-intl',
  'use-intl',
  '@t3-oss',
  '@formatjs',
  'intl-messageformat',
].join('|');
export default async function jestConfig(): Promise<Config> {
  const resolved = await createJestConfig(config)();
  return {
    ...resolved,
    transformIgnorePatterns: [`/node_modules/(?!(\.pnpm/)?(${esmOnly}))`, '^.+\.module\.(css|sass|scss)$'],
  };
}
