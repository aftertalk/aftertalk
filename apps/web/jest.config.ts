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
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};

// next/jest sets transformIgnorePatterns itself, so the ES-module-only packages are let through afterwards.
const esmOnly = ['better-auth', '@better-auth', 'next-intl', 'use-intl', '@t3-oss'].join('|');
export default async function jestConfig(): Promise<Config> {
  const resolved = await createJestConfig(config)();
  return {
    ...resolved,
    transformIgnorePatterns: [`/node_modules/(?!(\.pnpm/)?(${esmOnly}))`, '^.+\.module\.(css|sass|scss)$'],
  };
}
