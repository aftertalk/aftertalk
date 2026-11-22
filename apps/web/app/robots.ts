import type { MetadataRoute } from 'next';

// A self-hosted install is private: nothing is indexed, and there is no sitemap.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
