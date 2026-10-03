import 'server-only';
import type { ReactNode } from 'react';
import { DatabaseNotReadyError } from '@/data/client';
import { publicContext, requireContext, type GuardContext, type PublicContext } from './guard-core';
import { Shell } from './shell';

function databaseProblem(error: unknown): ReactNode {
  if (!(error instanceof DatabaseNotReadyError)) throw error;
  return (
    <main>
      <h1>Database not set up</h1>
      <p>{error.message}</p>
    </main>
  );
}

/** A page. Redirects to /login unless there is a valid session; renders inside the app shell. */
export function guardedPage<P = object>(
  fn: (ctx: GuardContext, props: P) => Promise<ReactNode> | ReactNode,
): (props: P) => Promise<ReactNode> {
  return async function GuardedPage(props: P) {
    let ctx: GuardContext;
    try {
      ctx = await requireContext();
    } catch (error) {
      return databaseProblem(error);
    }
    return <Shell>{await fn(ctx, props)}</Shell>;
  };
}

/** The login page only: it must be reachable before there is a session. */
export function publicPage<P = object>(
  fn: (ctx: PublicContext, props: P) => Promise<ReactNode> | ReactNode,
): (props: P) => Promise<ReactNode> {
  return async function PublicPage(props: P) {
    try {
      return await fn(await publicContext(), props);
    } catch (error) {
      return databaseProblem(error);
    }
  };
}
