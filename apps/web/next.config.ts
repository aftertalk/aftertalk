import { NextConfig } from 'next';

import eeRoutes from './ee/routes';

const isDev = process.env.NODE_ENV === 'development';

// Enforced policy. 'unsafe-inline' because Next's inline bootstrap scripts carry no nonce;
// development also needs 'unsafe-eval'. The commercial fork adds hosts through ee/routes.ts.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  ["connect-src 'self'", ...eeRoutes.connectSrc].join(' '),
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['postgres'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

// next-intl's plugin is added with i18n/request.ts in phase 1.
export default nextConfig;
