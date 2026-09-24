/** Shapes returned by the Meter owner API (apps/server owner.controller.ts). Money is a decimal string. */
export interface Credential {
  readonly id: string;
  readonly public_id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly status: 'active' | 'revoked';
  readonly expires_at: string;
  readonly last_used_at: string | null;
  readonly created_at: string;
}

export interface IssuedCredential {
  readonly id: string;
  readonly public_id: string;
  readonly label: string;
  readonly token: string;
}

export interface Mandate {
  readonly id: string;
  readonly name: string;
  readonly asset: string;
  readonly status: 'active' | 'revoked';
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly limits: {
    readonly per_transaction: string;
    readonly daily: string;
    readonly lifetime: string;
    readonly velocity: { readonly max_count: number; readonly window_secs: number };
    readonly max_in_flight: number;
    readonly duplicate_window_secs: number;
    readonly allowed_categories: readonly string[];
    readonly allowed_destinations: readonly string[] | null;
  };
  readonly exposure: {
    readonly today: string;
    readonly lifetime: string;
    readonly daily_remaining: string;
    readonly lifetime_remaining: string;
    readonly in_flight: number;
    readonly daily_resets_at: string;
  };
  readonly credentials: readonly Credential[];
  readonly created_at: string;
}

export type PurchaseStatus = 'processing' | 'delivered' | 'failed' | 'expired' | 'declined';

export interface Purchase {
  readonly purchase_id: string;
  readonly status: PurchaseStatus;
  readonly delivery_status: string;
  readonly network: string;
  readonly destination: string;
  readonly amount: string;
  readonly amount_charged: string;
  readonly amount_released: string;
  readonly amount_held: string;
  readonly provider_reference: string | null;
  readonly intent: string;
  readonly credential_label?: string;
  readonly created_at: string;
}

export interface TimelineEntry {
  readonly at: string;
  readonly kind: 'decision' | 'ledger' | 'provider' | 'purchase';
  readonly summary: string;
  readonly detail: Record<string, unknown>;
}

export interface Timeline {
  readonly purchase_id: string;
  readonly correlation_id: string;
  readonly purchase: {
    readonly amount: string;
    readonly asset: string;
    readonly network: string;
    readonly destination: string;
    readonly intent: string;
    readonly delivery_status: string;
    readonly credential_label: string;
    readonly created_at: string;
  };
  readonly entries: readonly TimelineEntry[];
}

export interface Balance {
  readonly asset: string;
  readonly available: string;
  readonly reserved: string;
}

export interface CreateMandateInput {
  readonly name: string;
  readonly per_transaction_limit: string;
  readonly daily_limit: string;
  readonly lifetime_limit: string;
  readonly velocity: { readonly max_count: number; readonly window_secs: number };
  readonly max_in_flight: number;
  readonly duplicate_window_secs: number;
  readonly allowed_categories: readonly ['airtime'];
  readonly allowed_destinations: readonly string[] | null;
  readonly expires_at: string;
}

export interface MeterClient {
  balance(): Promise<Balance>;
  credit(amount: string): Promise<void>;
  mandates(): Promise<readonly Mandate[]>;
  mandate(id: string): Promise<Mandate>;
  createMandate(input: CreateMandateInput): Promise<Mandate>;
  revokeMandate(id: string, reason: string): Promise<void>;
  issueCredential(mandateId: string, label: string): Promise<IssuedCredential>;
  revokeCredential(id: string): Promise<void>;
  purchases(mandateId: string): Promise<readonly Purchase[]>;
  timeline(purchaseId: string): Promise<Timeline>;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
