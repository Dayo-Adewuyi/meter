import { ASSETS, toAtomic } from '@meter/contracts';
import { z } from 'zod';

const MIN_AIRTIME = 5_000n; // ₦50
const MAX_AIRTIME = 5_000_000n; // ₦50,000

/** Nigerian mobile number → E.164, or null. Accepts 0803…, 234803…, +234803…, with spaces or dashes. */
export function normalizeNigerianMobile(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const national = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits)?.[1];
  return national === undefined ? null : `+234${national}`;
}

/** `+2348030000000` → `+234803****000`, for logs and stored provider outcomes. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 7)}****${e164.slice(-3)}`;
}

/** Whole naira only, ₦50 to ₦50,000, as kobo. */
export function parseAirtimeAmount(input: string): bigint | null {
  let atomic: bigint;
  try {
    atomic = toAtomic(input, ASSETS.NGN);
  } catch {
    return null;
  }
  return atomic % 100n === 0n && atomic >= MIN_AIRTIME && atomic <= MAX_AIRTIME ? atomic : null;
}

export const purchaseRequestSchema = z
  .object({
    category: z.literal('airtime'),
    network: z.enum(['mtn', 'airtel', 'glo', '9mobile']),
    destination: z.string().transform((value, ctx) => {
      const normalized = normalizeNigerianMobile(value);
      if (normalized === null) ctx.addIssue({ code: 'custom', message: 'must be a valid Nigerian mobile number' });
      return normalized ?? '';
    }),
    amount: z.string().transform((value, ctx) => {
      const atomic = parseAirtimeAmount(value);
      if (atomic === null) ctx.addIssue({ code: 'custom', message: 'must be whole naira between 50 and 50000' });
      return atomic ?? 0n;
    }),
    intent: z.string().trim().min(1).max(280),
    confirm_duplicate: z.boolean().default(false),
  })
  .strict();

export type PurchaseRequest = z.output<typeof purchaseRequestSchema>;
