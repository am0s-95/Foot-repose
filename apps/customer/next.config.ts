import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@foot-repose/domain', '@foot-repose/contracts'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
