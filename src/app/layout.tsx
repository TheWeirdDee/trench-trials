import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trench Trials — Read the market before the name changes your mind',
  description:
    'A blind market game powered by Nansen. Compare three real tokens with their identities hidden, lock your read, reveal the tickers, and see what recognition cost you.',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#050505',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas font-sans text-cream antialiased">{children}</body>
    </html>
  );
}
