'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { ASSET_CLASSES } from '@/domain/trades/types';
import { emptyFormState, formValues, type FormState, type FormValues } from '../_lib/form';
import type { RiskPreview } from './actions';

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  accounts: { id: number; name: string; baseCurrency: string }[];
  setups: { id: number; name: string }[];
  mode: 'create' | 'edit';
  initial?: FormValues;
  /** Edit mode: names of the fields that may still be changed. Others are shown but disabled. */
  editable?: readonly string[];
  submitLabel: string;
  /** Create mode: asks the server for the live risk verdict of the plan (saves nothing). */
  preview?: (values: FormValues) => Promise<RiskPreview>;
}

export function TradeForm({
  action,
  accounts,
  setups,
  mode,
  initial = {},
  editable,
  submitLabel,
  preview,
}: Props) {
  const [state, formAction, pending] = useActionState(action, emptyFormState);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [verdict, setVerdict] = useState<RiskPreview | null>(null);
  const [checking, setChecking] = useState(false);

  // Live risk verdict: a moment after you stop typing, ask the server (same engine, same rules).
  const refresh = () => {
    if (!preview || !formRef.current) return;
    const values = formValues(new FormData(formRef.current));
    setChecking(true);
    preview(values)
      .then(setVerdict)
      .catch(() => setVerdict(null))
      .finally(() => setChecking(false));
  };
  const scheduleRefresh = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 400);
  };
  useEffect(() => {
    refresh();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refused = state.needsOverride || (verdict !== null && !verdict.approved);
  const value = (name: string) => state.values[name] ?? initial[name] ?? '';
  const locked = (name: string) => mode === 'edit' && !editable?.includes(name);
  const field = (name: string) => ({
    name,
    defaultValue: value(name),
    disabled: locked(name),
  });
  const row = (label: string, input: ReactNode, hint?: string) => (
    <p>
      <label>
        {label} {input}
      </label>
      {hint && <small> {hint}</small>}
    </p>
  );

  return (
    <form action={formAction} ref={formRef} onChange={scheduleRefresh} onInput={scheduleRefresh}>
      {state.errors.length > 0 && (
        <div role="alert">
          <strong>Please fix:</strong>
          <ul>
            {state.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Remount the inputs after a failed submit so they show what you typed. */}
      <fieldset key={JSON.stringify(state.values)} style={{ border: 0, padding: 0 }}>
        {mode === 'create'
          ? row(
              'Account',
              <select {...field('accountId')} required>
                <option value="">-- choose --</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.baseCurrency})
                  </option>
                ))}
              </select>,
            )
          : null}
        {row(
          'Setup',
          <select {...field('setupId')}>
            <option value="">(none)</option>
            {setups.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>,
        )}
        {row('Symbol', <input {...field('symbol')} required maxLength={30} />, 'e.g. BTCUSDT')}
        {row(
          'Asset class',
          <select {...field('assetClass')} required>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>,
        )}
        {row(
          'Direction',
          <select {...field('direction')} required>
            <option value="long">long (buy)</option>
            <option value="short">short (sell)</option>
          </select>,
        )}
        {mode === 'create' &&
          row(
            'Status',
            <select {...field('status')}>
              <option value="planned">planned (not taken yet)</option>
              <option value="open">open (already taken)</option>
            </select>,
          )}
        {row(
          'Planned entry',
          <input {...field('plannedEntry')} required inputMode="decimal" />,
          'price',
        )}
        {row(
          'Stop-loss',
          <input {...field('stopLoss')} required inputMode="decimal" />,
          'REQUIRED. Long: below entry. Short: above entry.',
        )}
        {row(
          'Take-profit',
          <input {...field('takeProfit')} inputMode="decimal" />,
          'optional. Long: above entry. Short: below entry.',
        )}
        {row(
          'Size',
          <input {...field('size')} required inputMode="decimal" />,
          'units of the asset (0.5 BTC, 10 shares)',
        )}
        {row(
          'Quote currency',
          <input {...field('quoteCurrency')} required maxLength={10} />,
          'e.g. USDT, USD',
        )}
        {mode === 'create' && (
          <>
            {row(
              'Entry price',
              <input {...field('entryPrice')} inputMode="decimal" />,
              'only if status is open: the price you really got',
            )}
            {row(
              'Opened at',
              <input {...field('openedAt')} type="datetime-local" />,
              'only if status is open (your local time)',
            )}
          </>
        )}
        {row('Fees', <input {...field('fees')} inputMode="decimal" />, 'amount, default 0')}
        {row(
          'Fees currency',
          <input {...field('feesCurrency')} maxLength={10} />,
          'default: quote currency',
        )}
        {row(
          'Plan notes',
          <textarea {...field('planNotes')} rows={3} cols={60} maxLength={5000} />,
        )}
        {mode === 'edit' &&
          row(
            'Review notes',
            <textarea {...field('reviewNotes')} rows={3} cols={60} maxLength={5000} />,
          )}
        {row('Emotion', <input {...field('emotion')} maxLength={200} />, 'how did you feel?')}
        {row(
          'Screenshot',
          <input {...field('screenshotPath')} maxLength={500} size={50} />,
          'file path or http(s) link (no upload)',
        )}
      </fieldset>
      {preview && (
        <section
          aria-live="polite"
          style={{ border: '1px solid #888', padding: '0.5rem 1rem', margin: '1rem 0' }}
        >
          <strong>Risk check{checking ? ' (checking…)' : ''}</strong>
          {verdict === null ? (
            <p>Fill in the plan to see the risk check.</p>
          ) : (
            <>
              <p>
                {verdict.approved
                  ? 'APPROVED by the risk engine.'
                  : 'REFUSED by the risk engine. Reasons:'}
              </p>
              {verdict.violations.length > 0 && (
                <ul>
                  {verdict.violations.map((v) => (
                    <li key={v.code + v.message}>
                      <code>{v.code}</code> {v.message}
                    </li>
                  ))}
                </ul>
              )}
              {verdict.warnings.length > 0 && (
                <ul>
                  {verdict.warnings.map((w) => (
                    <li key={w.code}>
                      Warning <code>{w.code}</code>: {w.message}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                <small>
                  Risk on this trade: {verdict.numbers.riskAmount ?? 'n/a'} (
                  {verdict.numbers.riskPercent ?? 'n/a'}% of equity{' '}
                  {verdict.numbers.equity ?? 'n/a'}) | Open risk after:{' '}
                  {verdict.numbers.openRiskAfter ?? 'n/a'} (
                  {verdict.numbers.openRiskAfterPercent ?? 'n/a'}%) | Open trades after:{' '}
                  {verdict.numbers.openTradesAfter} of {verdict.numbers.maxOpenTrades ?? 'n/a'} |
                  Reward-to-risk: {verdict.numbers.rewardToRisk ?? 'n/a'}
                </small>
              </p>
            </>
          )}
        </section>
      )}
      {preview && refused && (
        <section style={{ border: '1px solid #c33', padding: '0.5rem 1rem', margin: '1rem 0' }}>
          <strong>Log it anyway? (override)</strong>
          <p>
            <small>
              The journal may record a plan that breaks your rules, but it is flagged as an OVERRIDE
              forever. Real orders can never be overridden.
            </small>
          </p>
          <p>
            <label>
              Type OVERRIDE <input name="overrideConfirm" autoComplete="off" />
            </label>
          </p>
          <p>
            <label>
              Reason (at least 10 characters){' '}
              <input name="overrideReason" size={60} maxLength={500} autoComplete="off" />
            </label>
          </p>
        </section>
      )}
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
