import type { Metadata, Viewport } from 'next';
import { EB_Garamond, Grenze_Gotisch, IBM_Plex_Mono } from 'next/font/google';
import { Shell } from '@/components/Shell';
import './globals.css';

// Blackletter for display only; Garamond for every sentence and figure.
const grenze = Grenze_Gotisch({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-grenze', display: 'swap' });
const garamond = EB_Garamond({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-garamond', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Meter — The Covenants', template: '%s · Meter' },
  description: 'Lend your AI agents bounded, witnessed, revocable authority to spend.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = { themeColor: '#0b0a09', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={`${grenze.variable} ${garamond.variable} ${plexMono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
