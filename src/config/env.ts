import { z } from 'zod';

/**
 * Trading mode guard (rules 4 and 5).
 * Real execution does not exist yet, so "paper" is the ONLY accepted value.
 * Anything else (including "live") makes startup fail instead of silently
 * running in a mode the code cannot safely support.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default('file:./data/houcine-trades.db'),
  TRADING_MODE: z
    .literal('paper', { error: 'TRADING_MODE must be "paper": real execution is not implemented.' })
    .default('paper'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration - ${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Validated environment, read once from process.env. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
