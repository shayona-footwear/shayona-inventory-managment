/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // Allow local network devices (phones, tablets on the same Wi-Fi) to
  // access HMR/webpack dev resources without the cross-origin block warning.
  allowedDevOrigins: [
    '192.168.29.112',
    '192.168.*.*',
  ],
  // Send every production alias to the primary domain so the Google OAuth
  // callback and session cookie always live on the same host.
  async redirects() {
    return [
      'localhost',
      '127.0.0.1',
      'shayona-inventory-managment.vercel.app',
    ].map((host) => ({
      source: '/:path*',
      has: [{ type: 'host', value: host }],
      destination: 'https://shayona-footwear.vercel.app/:path*',
      permanent: false,
    }))
  },
}

export default nextConfig
