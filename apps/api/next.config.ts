import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@foot-repose/domain', '@foot-repose/db', '@foot-repose/contracts'],
  serverExternalPackages: ['pg'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
