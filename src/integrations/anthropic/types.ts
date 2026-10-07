/**
 * The ONE interface between the analyst and the AI provider. The app and every test use this
 * interface; the real implementation (client.ts) talks to the provider, the fake one (in the
 * tests) never touches the network.
 *
 * There is deliberately NO field for tools, files, web search or any other capability: a request
 * is text in, text out.
 */

export interface AnalystRequest {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Sent only for models that accept it (see the price table). */
  effort: 'low' | null;
}

export type AnalystFailure = 'api_error' | 'timeout' | 'refused' | 'truncated';

export type AnalystResult =
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | {
      ok: false;
      reason: AnalystFailure;
      /** Tokens the provider reported, when it did (a truncated reply is still billed). */
      inputTokens: number | null;
      outputTokens: number | null;
      /**
       * Could this failure still have been billed? 'none': the provider answered with an HTTP
       * error (nothing was generated). 'unknown': the request may have run (timeout, unreadable
       * reply, network cut): the usage log then counts the worst case.
       */
      billing: 'none' | 'unknown';
      /** A short, fixed-vocabulary description. Never a key, a prompt or provider free text. */
      detail: string;
    };

export interface AnalystClient {
  complete(request: AnalystRequest): Promise<AnalystResult>;
}
