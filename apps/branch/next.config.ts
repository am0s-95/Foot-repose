import type { NextConfig } from 'next';

/** The shared backend. Frontends proxy /api/* so the browser stays same-origin
 * and session cookies need no CORS. */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  transpilePackages: ['@foot-repose/domain', '@foot-repose/contracts'],
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
