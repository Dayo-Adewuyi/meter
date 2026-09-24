import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validation happens before any transaction (§8.2), with a stable code. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new BadRequestException({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request is invalid.',
        issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }
  return result.data;
}

export function idempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(header)) {
    throw new BadRequestException({
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Financial commands require an Idempotency-Key header.' },
    });
  }
  return header;
}
