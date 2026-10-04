import Link from 'next/link';
import type { ReactNode } from 'react';
import { logoutAction } from '../security/actions';

/** Navigation around every signed-in page. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="banner" role="status">
        <strong>Private workspace.</strong> Signed in as the owner. Paper mode only.
      </div>
      <nav className="main-nav">
        <Link href="/">Home</Link>
        <Link href="/trades">Trades</Link>
        <Link href="/trades/new">New trade</Link>
        <Link href="/stats">Stats</Link>
        <Link href="/risk">Risk</Link>
        <Link href="/accounts">Accounts</Link>
        <Link href="/setups">Setups</Link>
        <span className="spacer" />
        <Link href="/security">Security</Link>
        <form action={logoutAction} className="inline-form">
          <button type="submit" className="link-button">
            Log out
          </button>
        </form>
      </nav>
      <div className="content">{children}</div>
    </>
  );
}
