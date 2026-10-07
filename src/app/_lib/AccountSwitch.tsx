'use client';

interface Props {
  action: (formData: FormData) => Promise<void>;
  accounts: { id: number; name: string; baseCurrency: string }[];
  selectedId: number | null;
}

/** The account selector in the header. Changing it submits at once; the button is the fallback. */
export function AccountSwitch({ action, accounts, selectedId }: Props) {
  if (accounts.length === 0) return null;
  return (
    <form action={action} className="account-switch">
      <label htmlFor="account-select">Account</label>
      <select
        id="account-select"
        name="accountId"
        defaultValue={selectedId ?? undefined}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.baseCurrency})
          </option>
        ))}
      </select>
      <button type="submit" className="secondary">
        Switch
      </button>
    </form>
  );
}
