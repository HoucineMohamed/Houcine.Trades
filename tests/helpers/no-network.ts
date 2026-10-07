/**
 * Tests must never reach the network (and so never an AI provider, whatever key is in the
 * environment). Any accidental use of the global `fetch` fails loudly.
 */
globalThis.fetch = (() => {
  throw new Error('Network access is not allowed in tests: use the fake analyst client.');
}) as typeof fetch;
