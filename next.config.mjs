/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // NANSEN_API_KEY must never be exposed to the client. Only NEXT_PUBLIC_-prefixed
  // vars reach the browser bundle, and none are declared here.
  async redirects() {
    return [
      { source: '/replay', destination: '/play', permanent: false },
      { source: '/me', destination: '/history', permanent: false },
      { source: '/how-it-works', destination: '/docs#how-it-works', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
