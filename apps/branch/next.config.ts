import type { NextConfig } from 'next';

/**
 * [F29] No `rewrites()` here on purpose.
 *
 * `rewrites()` is evaluated during `next build`, so reading `process.env.API_URL`
 * in it wrote the destination into `.next/routes-manifest.json` and froze it:
 * an artifact built for one environment kept talking to that environment
 * wherever it ran, and moving it meant rebuilding it. The browser still calls
 * `/api/*` on this origin — that same-origin contract is what keeps the session
 * cookie HttpOnly with no CORS — but the forwarding now happens in a route
 * handler that reads the destination per request. See `src/app/api/[...path]`.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@foot-repose/domain', '@foot-repose/contracts'],
  // The deployable unit, so the routing fix can be proven on the thing that
  // actually ships rather than on `next start` inside this checkout.
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
