import { z } from 'zod';
import { nonEmptyText, text } from '../fields';

/** A setup is a strategy tag (for example "Breakout") used later for stats. */
export const setupSchema = z.strictObject({
  name: nonEmptyText('Setup name', 60),
  description: text('Description', 500).default(''),
});

export type SetupInput = z.input<typeof setupSchema>;
