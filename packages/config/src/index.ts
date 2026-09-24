import { z } from 'zod';

// Fail at boot, not at the first financial command.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  // Agent mandates run sandbox-only until the Stage 2 gate (agent-mandates §1.3).
  METER_AGENTS_SANDBOX: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  METER_CREDENTIAL_PEPPER: z.string().min(32).optional(),
  // The owner web app's origin. Unset means no cross-origin browser access.
  WEB_ORIGIN: z.url().optional(),
  // x402 (x402 design): a simulated chain by default; Base Sepolia for live testnet runs.
  METER_X402_CHAIN: z.enum(['simulated', 'base-sepolia']).default('simulated'),
  METER_X402_RPC_URL: z.url().optional(),
  METER_X402_SIGNER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  METER_X402_FACILITATOR_URL: z.url().default('https://x402.org/facilitator'),
  METER_X402_MERCHANT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
}).refine(
  // Tests inject a fake Clerk client; production must have the real secret.
  (value) => value.NODE_ENV !== 'production' || (value.CLERK_SECRET_KEY ?? '').length > 0,
  { message: 'CLERK_SECRET_KEY is required in production', path: ['CLERK_SECRET_KEY'] },
).refine(
  // A live chain needs a node to read and a funded key of its own; never the public sandbox key.
  (value) => value.METER_X402_CHAIN !== 'base-sepolia' || (value.METER_X402_RPC_URL !== undefined && value.METER_X402_SIGNER_KEY !== undefined),
  { message: 'METER_X402_RPC_URL and METER_X402_SIGNER_KEY are required for base-sepolia', path: ['METER_X402_CHAIN'] },
).refine(
  (value) => value.NODE_ENV !== 'production' || value.METER_CREDENTIAL_PEPPER !== undefined,
  { message: 'METER_CREDENTIAL_PEPPER is required in production', path: ['METER_CREDENTIAL_PEPPER'] },
);

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
