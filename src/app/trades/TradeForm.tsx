'use client';

import { useActionState, type ReactNode } from 'react';
import { ASSET_CLASSES } from '@/domain/trades/types';
import { emptyFormState, type FormState, type FormValues } from '../_lib/form';

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  accounts: { id: number; name: string; baseCurrency: string }[];
  setups: { id: number; name: string }[];
  mode: 'create' | 'edit';
  initial?: FormValues;
  /** Edit mode: names of the fields that may still be changed. Others are shown but disabled. */
  editable?: readonly string[];
  submitLabel: string;
}

export function TradeForm({
  action,
  accounts,
  setups,
  mode,
  initial = {},
  editable,
  submitLabel,
}: Props) {
  const [state, formAction, pending] = useActionState(action, emptyFormState);
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
    <form action={formAction}>
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
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
