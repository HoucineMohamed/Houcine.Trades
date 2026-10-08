'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/trades', label: 'Journal' },
  { href: '/trades/new', label: 'New trade' },
  { href: '/stats', label: 'Stats' },
  { href: '/risk', label: 'Risk' },
  { href: '/analyst', label: 'Analyst' },
  { href: '/notifications', label: 'Alerts' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/setups', label: 'Setups' },
];

function isCurrent(href: string, path: string): boolean {
  if (href === '/') return path === '/';
  if (href === '/trades')
    return path === '/trades' || (path.startsWith('/trades/') && path !== '/trades/new');
  return path === href || path.startsWith(`${href}/`);
}

export function NavLinks() {
  const path = usePathname();
  return (
    <>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={isCurrent(l.href, path) ? 'page' : undefined}
        >
          {l.label}
        </Link>
      ))}
    </>
  );
}

export function SecurityLink() {
  const path = usePathname();
  return (
    <Link href="/security" aria-current={path.startsWith('/security') ? 'page' : undefined}>
      Security
    </Link>
  );
}
