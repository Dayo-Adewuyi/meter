import { z } from 'zod';

/**
 * Money crosses the wire as a decimal string and lives in the server as bigint
 * atomic units (§10.3). `number` is prohibited for monetary values.
 */
export interface Asset {
  readonly code: string;
  readonly exponent: number;
}

export const ASSETS = {
  NGN: { code: 'NGN', exponent: 2 },
  USDC: { code: 'USDC', exponent: 6 },
} as const satisfies Record<string, Asset>;

export type AssetCode = keyof typeof ASSETS;

export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

export const moneySchema = z.object({
  amount: decimalString,
  asset: z.enum(Object.keys(ASSETS) as [AssetCode, ...AssetCode[]]),
});

export type Money = z.infer<typeof moneySchema>;

/** Decimal string -> atomic units. Rejects excess precision rather than rounding. */
export function toAtomic(value: string, asset: Asset): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) throw new RangeError(`not a decimal amount: ${value}`);
  const [, sign, whole, fraction = ''] = match as unknown as [string, string, string, string?];
  if ((fraction ?? '').length > asset.exponent) {
    throw new RangeError(`${value} exceeds ${asset.code} precision of ${asset.exponent}`);
  }
  const padded = (fraction ?? '').padEnd(asset.exponent, '0');
  return BigInt(`${sign}${whole}${padded}`);
}

/** Atomic units -> decimal string. Exact; never lossy. */
export function fromAtomic(atomic: bigint, asset: Asset): string {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(asset.exponent + 1, '0');
  const whole = digits.slice(0, digits.length - asset.exponent);
  const fraction = digits.slice(digits.length - asset.exponent);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
