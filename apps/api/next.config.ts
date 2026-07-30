import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@foot-repose/domain', '@foot-repose/db', '@foot-repose/contracts'],
  // A self-contained server directory is what gets deployed. Without it the only
  // proof of runtime behaviour is `next start` inside a checkout that still has
  // the repository's node_modules — which proves nothing about a deploy.
  output: 'standalone',
  // Kept OUT of the bundle and required at runtime, so Next's dependency tracer
  // copies the real package into the artifact. `bcryptjs` is listed because the
  // password worker requires it from an opaque source string the bundler cannot
  // see: without this the tracer copied ZERO of its files and the deployed
  // server would have had no bcryptjs at all.
  serverExternalPackages: ['pg', 'bcryptjs'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
