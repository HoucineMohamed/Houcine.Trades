/** What the security forms get back from their actions. Plain data: shown, never stored. */
export interface SecurityFormState {
  error?: string;
  message?: string;
  /** New recovery codes: shown ONCE in the response and never kept anywhere. */
  codes?: string[];
}

export const emptySecurityState: SecurityFormState = {};
