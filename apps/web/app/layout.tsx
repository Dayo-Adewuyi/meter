import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Meter',
  description: 'Pay for what you actually use.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = { themeColor: '#0b0b0c' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
