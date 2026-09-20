// §12.2. Every handler is idempotent with bounded retries and dead-letter behaviour.
export const QUEUES = [
  'payment-webhook',
  'funding-reconciliation',
  'provider-finalization',
  'settlement',
  'notification',
  'refund',
  'risk-review',
  'data-retention',
  'daily-reconciliation',
] as const;

export type Queue = (typeof QUEUES)[number];
