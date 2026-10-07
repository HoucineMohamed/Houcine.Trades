import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { parseTheme, THEME_COOKIE } from './_lib/account';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

export const metadata: Metadata = {
  title: 'Houcine.Trades',
  description: 'Private trading workspace',
};

// The layout touches no data and no session: every page checks access itself (guard.tsx). It only
// reads the display preference (theme) from a cookie.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme === 'system' ? undefined : theme}>
      <body>{children}</body>
    </html>
  );
}
