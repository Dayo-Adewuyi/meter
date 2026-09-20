/**
 * A user lifecycle change, in Meter's own terms (§15.2). Adapters translate a
 * provider's webhook payload into this; nothing downstream knows about Clerk.
 */
export interface ExternalUserEvent {
  readonly kind: 'created' | 'updated' | 'deleted';
  readonly provider: 'clerk';
  readonly subject: string;
  /** Banned or locked upstream. Not meaningful for `deleted`. */
  readonly disabled: boolean;
}

export type ProvisioningOutcome = 'created' | 'updated' | 'unchanged';
