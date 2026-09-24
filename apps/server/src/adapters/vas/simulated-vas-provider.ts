import type { AirtimeRequest, RequeryOutcome, SendOutcome, VasProvider } from './vas-provider.port.ts';

export interface SimulatorCall {
  readonly kind: 'send' | 'requery';
  readonly requestId: string;
  readonly at: Date;
}

export interface SimulatorOptions {
  /** Delay before a successful send answers (§9.2: 300 ms). */
  readonly latencyMs?: number;
  /** How long scenario 0007 hangs, so a worker can be killed mid-call. */
  readonly hangMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic, fault-injecting provider keyed on the destination's last
 * four digits (§9.2), so every outcome path can be shown on demand.
 */
export class SimulatedVasProvider implements VasProvider {
  readonly name = 'simulator';
  readonly calls: SimulatorCall[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly options: SimulatorOptions = {}) {}

  sends(requestId: string): number {
    return this.calls.filter((call) => call.kind === 'send' && call.requestId === requestId).length;
  }

  requeries(requestId: string): number {
    return this.calls.filter((call) => call.kind === 'requery' && call.requestId === requestId).length;
  }

  async sendAirtime(request: AirtimeRequest): Promise<SendOutcome> {
    this.calls.push({ kind: 'send', requestId: request.requestId, at: new Date() });
    const attempt = this.bump(`send:${request.requestId}`);
    const reference = `SIM-${request.requestId.slice(-8)}`;

    switch (request.destination.slice(-4)) {
      case '0001':
        return { kind: 'rejected', code: 'INVALID_NUMBER' };
      case '0002':
      case '0003':
      case '0005':
        return { kind: 'unknown', reason: 'timeout after write' };
      case '0004':
        return { kind: 'unknown', reason: 'HTTP 502' };
      case '0006':
        if (attempt <= 2) return { kind: 'not_sent', reason: 'connection refused' };
        break;
      case '0007':
        await sleep(this.options.hangMs ?? 20_000);
        break;
    }
    await sleep(this.options.latencyMs ?? 300);
    return { kind: 'delivered', providerReference: reference, evidence: { providerStatus: 'SUCCESSFUL' } };
  }

  async requery(request: AirtimeRequest): Promise<RequeryOutcome> {
    const { requestId, destination } = request;
    this.calls.push({ kind: 'requery', requestId, at: new Date() });
    const attempt = this.bump(`requery:${requestId}`);
    const delivered: RequeryOutcome = {
      kind: 'delivered',
      providerReference: `SIM-${requestId.slice(-8)}`,
      evidence: { providerStatus: 'SUCCESSFUL' },
    };

    switch (destination.slice(-4)) {
      case '0001':
        return { kind: 'rejected', code: 'INVALID_NUMBER' };
      case '0002':
        return attempt === 1 ? { kind: 'pending' } : delivered;
      case '0003':
        return attempt === 1 ? { kind: 'pending' } : { kind: 'rejected', code: 'PRODUCT_UNAVAILABLE' };
      case '0004':
        return attempt <= 2 ? { kind: 'not_found' } : delivered;
      case '0005':
        return { kind: 'pending' };
      default:
        return delivered;
    }
  }

  private bump(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}
