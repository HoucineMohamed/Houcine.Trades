import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Houcine.Trades',
  description: 'Private trading workspace',
};

// The layout touches no data and no session: every page checks access itself (guard.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
