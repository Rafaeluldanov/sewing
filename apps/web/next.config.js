/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Используем TS-исходники shared-пакета напрямую, без билда
  // (см. README и packages/shared/package.json).
  transpilePackages: ['@sewing/shared'],
  experimental: {
    // Нужны для корректной работы серверных экшенов и fetch-кеша
    // при локальной разработке.
    serverActions: { allowedOrigins: [] },
  },
};

module.exports = nextConfig;
