import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getReview } from '@/data/analyst';
import { KIND_LABELS } from '@/domain/analyst';
import { formatLocal } from '../../../_lib/form';
import { guardedPage } from '../../../_lib/guard';
import { AnalystOutputView } from '../../AnalystOutputView';

export default guardedPage(
  async (
    ctx,
    {
      params,
      searchParams,
    }: { params: Promise<{ id: string }>; searchParams: Promise<{ stored?: string }> },
  ) => {
    const { id } = await params;
    const sp = await searchParams;
    if (!/^\d{1,9}$/.test(id)) notFound();
    const review = getReview(ctx.db, Number(id));
    if (!review) notFound();
    return (
      <main>
        <div className="page-head">
          <h1>{KIND_LABELS[review.kind]}</h1>
          <p className="lead">
            {review.subject} · {formatLocal(review.createdAt)} (local) · model {review.model}
            {review.currency ? ` · ${review.currency}` : ''}{' '}
            <Link href="/analyst">All answers</Link>
          </p>
        </div>
        {review.output === null ? (
          <p role="alert" className="notice notice-alert">
            This stored answer no longer passes validation, so it is not shown.
          </p>
        ) : (
          <AnalystOutputView
            kind={review.kind}
            output={review.output}
            checks={review.checks}
            fromStore={sp.stored === '1'}
            createdAt={review.createdAt}
          />
        )}
      </main>
    );
  },
);
