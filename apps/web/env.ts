import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

import eeEnv from './ee/env';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'production', 'test']),
    DATABASE_URL: z.string().url(),
    DATA_DIR: z.string().default('/data'),
    PUBLIC_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    // 32 bytes, base64.
    SECRETS_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64'),
    ENGINE_URL: z.string().url(),
    ENGINE_CALLBACK_SECRET: z.string().min(16),
    ENGINE_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).default(2),
    // Comma-separated host names, compared lower-case and exactly; empty means any host.
    PROVIDER_HOST_ALLOWLIST: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      ),
    // Comma-separated IPs or CIDR ranges of the reverse proxy in front of web, if any.
    TRUSTED_PROXIES: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean)
      ),
    ...eeEnv,
  },
  client: {},
  experimental__runtimeEnv: {},
  // The image is built without a database or secrets.
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
