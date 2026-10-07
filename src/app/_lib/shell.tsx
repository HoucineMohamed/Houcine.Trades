import Link from 'next/link';
import type { ReactNode } from 'react';
import { getEnv } from '@/config/env';
import { loadRiskContext } from '@/data/risk';
import { logoutAction } from '../security/actions';
import { THEME_COOKIE, parseTheme, selectedAccount, THEMES } from './account';
import { AccountSwitch } from './AccountSwitch';
import type { GuardContext } from './guard-core';
import { NavLinks, SecurityLink } from './NavLinks';
import { selectAccountAction, setThemeAction } from './preferences';
import { riskStatus } from './status';
import { cookies } from 'next/headers';

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' } as const;

/** Header, navigation and page frame around every signed-in page. Displays; decides nothing. */
export async function Shell({ ctx, children }: { ctx: GuardContext; children: ReactNode }) {
  const { accounts, selected } = await selectedAccount(ctx);
  const statuses = accounts.map((a) => ({
    account: a,
    status: riskStatus(loadRiskContext(ctx.db, a.id, ctx.now)),
  }));
  const status = statuses.find((s) => s.account.id === selected?.id)?.status ?? null;
  // an account that is halted or unverifiable must not hide behind the one that is selected
  const others = statuses.filter((s) => s.account.id !== selected?.id && s.status.tone !== 'clear');
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="banner-local" role="note">
        <strong>LOCALHOST ONLY.</strong> Sign-in protects this app, but it must not be exposed to a
        network until module 8 (HTTPS and backups).
      </div>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="wordmark">
            Houcine.Trades
          </Link>
          <span className="badge badge-paper" title="No real orders can be placed">
            {(selected?.mode ?? getEnv().TRADING_MODE).toUpperCase()}
          </span>
          {status && (
            <span
              className={
                status.tone === 'halted'
                  ? 'badge badge-halt'
                  : status.tone === 'unverified'
                    ? 'badge badge-unverified'
                    : 'badge badge-note'
              }
              role="status"
              title={status.detail}
            >
              {status.label}
            </span>
          )}
          {others.map((o) => (
            <span
              key={o.account.id}
              className={o.status.tone === 'halted' ? 'badge badge-halt' : 'badge badge-unverified'}
              role="status"
              title={o.status.detail}
            >
              {o.account.name}: {o.status.label}
            </span>
          ))}
          <div className="header-tools">
            <AccountSwitch
              action={selectAccountAction}
              accounts={accounts.map((a) => ({
                id: a.id,
                name: a.name,
                baseCurrency: a.baseCurrency,
              }))}
              selectedId={selected?.id ?? null}
            />
            <form action={setThemeAction} className="theme-toggle" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="submit"
                  name="theme"
                  value={t}
                  aria-pressed={theme === t}
                  className="secondary"
                >
                  {THEME_LABEL[t]}
                </button>
              ))}
            </form>
          </div>
        </div>
      </header>
      <div className="nav-wrap">
        <nav className="main-nav" aria-label="Main">
          <NavLinks />
          <span className="nav-end">
            <SecurityLink />
            <form action={logoutAction} className="inline-form">
              <button type="submit" className="link">
                Log out
              </button>
            </form>
          </span>
        </nav>
      </div>
      <div id="content" tabIndex={-1}>
        {children}
      </div>
    </>
  );
}
