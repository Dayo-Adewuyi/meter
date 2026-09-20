import type { NextConfig } from 'next';

// Statically delivered through Cloudflare; the API is a separate origin (§6.1).
const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  transpilePackages: ['@meter/contracts'],
};

export default config;
