'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import { Inscribe } from '@/components/Inscribe';
import { FORWARD, PageTransition } from '@/components/PageTransition';
import { Seal, Warning } from '@/components/icons';
import { compareAmounts, longDate, money, span } from '@/lib/format';
import { useMeter } from '@/lib/meter';
import { ApiError } from '@/lib/types';

const WINDOWS = [
  [60, 'a minute'],
  [600, 'ten minutes'],
  [3_600, 'an hour'],
  [86_400, 'a day'],
] as const;

const DUPLICATE_WINDOWS = [
  [0, 'Never — allow identical deeds'],
  [60, 'One minute'],
  [120, 'Two minutes'],
  [300, 'Five minutes'],
] as const;

const inThirtyDays = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const AMOUNTS = { airtime: /^\d{1,9}(\.\d{1,2})?$/, x402: /^\d{1,9}(\.\d{1,6})?$/ };
const PHONE = /^(?:\+?234|0)[789][01]\d{8}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Kind = 'airtime' | 'x402';

/** The same covenant, spelled per trade: NGN airtime or USDC web tolls. */
const KINDS = {
  airtime: { asset: 'NGN' as const, label: 'Airtime', prefix: '₦', suffix: undefined, defaults: { perDeed: '2000', perDay: '5000', inAll: '50000', destinations: '' } },
  x402: { asset: 'USDC' as const, label: 'Paid web resources (x402)', prefix: undefined, suffix: 'USDC', defaults: { perDeed: '0.50', perDay: '5', inAll: '50', destinations: 'http://localhost:3001' } },
};

const originOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
};

interface Draft {
  kind: Kind;
  counterparties: string;
  name: string;
  perDeed: string;
  perDay: string;
  inAll: string;
  velocityCount: string;
  velocityWindow: string;
  inFlight: string;
  duplicateWindow: string;
  destinations: string;
  until: string;
}

const INITIAL: Draft = {
  kind: 'airtime',
  counterparties: '',
  name: '',
  perDeed: '2000',
  perDay: '5000',
  inAll: '50000',
  velocityCount: '5',
  velocityWindow: '600',
  inFlight: '3',
  duplicateWindow: '120',
  destinations: '',
  until: inThirtyDays(),
};

type Errors = Partial<Record<keyof Draft, string>>;

function validate(d: Draft): Errors {
  const errors: Errors = {};
  if (d.name.trim().length === 0) errors.name = 'Name the covenant, so you know it again.';
  else if (d.name.trim().length > 80) errors.name = 'Keep the name under 80 characters.';
  for (const key of ['perDeed', 'perDay', 'inAll'] as const) {
    if (!AMOUNTS[d.kind].test(d[key]) || compareAmounts(d[key], '0') <= 0) {
      errors[key] = d.kind === 'airtime' ? 'A positive amount in naira, e.g. 2000 or 2000.50.' : 'A positive amount in USDC, up to 6 decimals, e.g. 0.50.';
    }
  }
  if (errors.perDeed === undefined && errors.perDay === undefined && compareAmounts(d.perDeed, d.perDay) > 0) {
    errors.perDay = 'A day must allow at least one full deed.';
  }
  if (errors.perDay === undefined && errors.inAll === undefined && compareAmounts(d.perDay, d.inAll) > 0) {
    errors.inAll = 'The whole covenant must allow at least one full day.';
  }
  if (!/^\d+$/.test(d.velocityCount) || Number(d.velocityCount) < 1) errors.velocityCount = 'At least one deed.';
  if (!/^\d+$/.test(d.inFlight) || Number(d.inFlight) < 1) errors.inFlight = 'At least one at a time.';
  const bad = lines(d.destinations).find((line) => (d.kind === 'airtime' ? !PHONE.test(line.replace(/[\s-]/g, '')) : originOf(line) === null));
  if (bad !== undefined) errors.destinations = d.kind === 'airtime' ? `“${bad}” is not a Nigerian mobile number.` : `“${bad}” is not an http(s) origin.`;
  const badAddress = d.kind === 'x402' ? lines(d.counterparties).find((line) => !ADDRESS.test(line)) : undefined;
  if (badAddress !== undefined) errors.counterparties = `“${badAddress}” is not an address (0x followed by 40 hex characters).`;
  if (d.until.length === 0 || new Date(`${d.until}T23:59:59+01:00`) <= new Date()) errors.until = 'Choose a day in the future.';
  return errors;
}

const lines = (text: string) => text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
const display = (amount: string, kind: Kind) => (AMOUNTS[kind].test(amount) ? money(amount, KINDS[kind].asset) : kind === 'airtime' ? '₦—' : '— USDC');

function Field({
  id,
  label,
  error,
  help,
  required,
  prefix,
  suffix,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  help?: string;
  required?: boolean;
  prefix?: string;
  suffix?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="req" aria-hidden="true">
            ✦
          </span>
        ) : null}
      </label>
      <div className="input" data-invalid={error !== undefined}>
        {prefix === undefined ? null : <span className="input__affix" aria-hidden="true">{prefix}</span>}
        {children}
        {suffix === undefined ? null : <span className="input__affix input__affix--end">{suffix}</span>}
      </div>
      {error !== undefined ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : help !== undefined ? (
        <p className="field__help" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** The covenant, read back as the document it is. */
function Vellum({ d }: { d: Draft }) {
  const window = WINDOWS.find(([seconds]) => String(seconds) === d.velocityWindow)?.[1] ?? span(Number(d.velocityWindow));
  const places = lines(d.destinations);
  return (
    <article className="vellum" aria-label="Preview of the covenant as written">
      <h2 className="vellum__title">{d.name.trim() || 'An untitled covenant'}</h2>
      <p className="vellum__body">
        Let it be known that any agent bearing a seal of this covenant may{' '}
        {d.kind === 'airtime' ? (
          <>
            buy <strong>airtime</strong> from your treasury
            {places.length === 0 ? ' for any number' : ` for ${places.length === 1 ? 'the number ' + places[0] : `these ${places.length} numbers alone`}`}
          </>
        ) : (
          <>
            pay the tolls of <strong>web resources</strong> in USDC
            {places.length === 0 ? ' on any site' : ` on ${places.length === 1 ? places[0] : `these ${places.length} sites alone`}`}, each toll charged only once the chain has made it final
          </>
        )}
        , spending no more than <strong>{display(d.perDeed, d.kind)}</strong> in a single deed, <strong>{display(d.perDay, d.kind)}</strong> in one day, and{' '}
        <strong>{display(d.inAll, d.kind)}</strong> in all; making no more than <strong>{d.velocityCount || '—'}</strong> deeds in {window}, nor more
        than <strong>{d.inFlight || '—'}</strong> at once
        {d.duplicateWindow === '0' ? '' : ', nor repeating an identical deed without your word'}; until{' '}
        <strong>{d.until ? longDate(`${d.until}T12:00:00+01:00`) : '—'}</strong>, or until you break its seal.
      </p>
      <div className="vellum__foot">
        <span className="vellum__sign">Witnessed by the ledger</span>
        <Seal size={44} style={{ color: 'var(--blood)' }} />
      </div>
    </article>
  );
}

export default function DrawCovenant() {
  const { client } = useMeter();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const errors = useMemo(() => validate(draft), [draft]);
  // An ordering error belongs to both fields it compares; show it once either was touched.
  const linked: Partial<Record<keyof Draft, (keyof Draft)[]>> = { perDay: ['perDeed'], inAll: ['perDay'] };
  const shown = (key: keyof Draft) =>
    submitted || touched[key] || (linked[key] ?? []).some((other) => touched[other]) ? errors[key] : undefined;

  const affix = draft.kind === 'airtime' ? { prefix: '₦' } : { suffix: 'USDC' };
  const bind = (key: Exclude<keyof Draft, 'kind'>) => ({
    id: key,
    name: key,
    value: draft[key],
    onChange: (event: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: event.target.value })),
    onBlur: () => setTouched((t) => ({ ...t, [key]: true })),
    'aria-invalid': shown(key) !== undefined,
    'aria-describedby': shown(key) !== undefined ? `${key}-error` : `${key}-help`,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    const first = Object.keys(errors)[0];
    if (first !== undefined) {
      document.getElementById(first)?.focus();
      return;
    }
    setBusy(true);
    try {
      const destinations = lines(draft.destinations);
      const mandate = await client.createMandate({
        name: draft.name.trim(),
        asset: KINDS[draft.kind].asset,
        per_transaction_limit: draft.perDeed,
        daily_limit: draft.perDay,
        lifetime_limit: draft.inAll,
        velocity: { max_count: Number(draft.velocityCount), window_secs: Number(draft.velocityWindow) },
        max_in_flight: Number(draft.inFlight),
        duplicate_window_secs: Number(draft.duplicateWindow),
        allowed_categories: draft.kind === 'airtime' ? ['airtime'] : ['x402'],
        allowed_destinations: destinations.length === 0 ? null : draft.kind === 'x402' ? destinations.map((d) => originOf(d)!) : destinations,
        allowed_counterparties: draft.kind === 'x402' && lines(draft.counterparties).length > 0 ? lines(draft.counterparties) : null,
        expires_at: new Date(`${draft.until}T23:59:59+01:00`).toISOString(),
      });
      router.push(`/mandate?id=${mandate.id}&drawn=1`, { transitionTypes: FORWARD });
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'The covenant could not be drawn. Try again.');
      setBusy(false);
    }
  };

  return (
    <PageTransition>
      <main id="main" tabIndex={-1}>
        <div className="frame">
          <div style={{ paddingTop: 'clamp(40px, 7vw, 96px)' }}>
            <p className="eyebrow eyebrow--gilt">A new covenant</p>
            <Inscribe text="Draw the terms" className="display--page" />
            <p className="lede" style={{ marginTop: 24 }}>
              An agent may do only what is written here. Every limit is enforced before a single kobo is held.
            </p>
          </div>

          <div className="draft">
            <form onSubmit={submit} noValidate aria-describedby={failure === null ? undefined : 'form-failure'}>
              {failure === null ? null : (
                <p className="alert" id="form-failure" role="alert" style={{ marginBottom: 24 }}>
                  <Warning size={18} />
                  {failure}
                </p>
              )}

              <fieldset className="article-set">
                <legend>
                  <span className="article-set__numeral">I</span>
                  <span className="article-set__title">The name</span>
                </legend>
                <Field id="name" label="Covenant" required error={shown('name')} help="Who or what it is for — “Mama's line”, “Travel top-ups”.">
                  <input {...bind('name')} autoComplete="off" maxLength={80} placeholder="Mama's line" />
                </Field>
              </fieldset>

              <fieldset className="article-set">
                <legend>
                  <span className="article-set__numeral">II</span>
                  <span className="article-set__title">The purse</span>
                </legend>
                <div className="grid-3">
                  <Field id="perDeed" {...affix} label="Per deed" required error={shown('perDeed')} help="Largest single purchase.">
                    <input {...bind('perDeed')} inputMode="decimal" />
                  </Field>
                  <Field id="perDay" {...affix} label="Per day" required error={shown('perDay')} help="Resets at midnight, Lagos.">
                    <input {...bind('perDay')} inputMode="decimal" />
                  </Field>
                  <Field id="inAll" {...affix} label="In all" required error={shown('inAll')} help="For the life of the covenant.">
                    <input {...bind('inAll')} inputMode="decimal" />
                  </Field>
                </div>
              </fieldset>

              <fieldset className="article-set">
                <legend>
                  <span className="article-set__numeral">III</span>
                  <span className="article-set__title">The pace</span>
                </legend>
                <div className="grid-3">
                  <Field id="velocityCount" label="At most" required suffix="deeds" error={shown('velocityCount')}>
                    <input {...bind('velocityCount')} inputMode="numeric" />
                  </Field>
                  <Field id="velocityWindow" label="Within">
                    <select {...bind('velocityWindow')}>
                      {WINDOWS.map(([seconds, words]) => (
                        <option key={seconds} value={seconds}>
                          {words}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="inFlight" label="At once" required suffix="in passage" error={shown('inFlight')}>
                    <input {...bind('inFlight')} inputMode="numeric" />
                  </Field>
                </div>
                <div style={{ marginTop: 20 }}>
                  <Field id="duplicateWindow" label="Refuse an identical deed within" help="Agents retry. This stops the same number and amount twice unless the user asked for it.">
                    <select {...bind('duplicateWindow')}>
                      {DUPLICATE_WINDOWS.map(([seconds, words]) => (
                        <option key={seconds} value={seconds}>
                          {words}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </fieldset>

              <fieldset className="article-set">
                <legend>
                  <span className="article-set__numeral">IV</span>
                  <span className="article-set__title">The reach</span>
                </legend>
                <div className="grid-2">
                  <Field id="kind" label="What may be bought" help={draft.kind === 'airtime' ? 'Nigerian airtime, from your naira balance.' : 'Web resources that charge per request over HTTP 402, from your USDC balance.'}>
                    <select
                      id="kind"
                      value={draft.kind}
                      onChange={(event) => {
                        const kind = event.target.value as Kind;
                        // A trade has its own currency: reset the purse to sensible amounts in it.
                        setDraft((d) => ({ ...d, kind, ...KINDS[kind].defaults, counterparties: '' }));
                      }}
                    >
                      {(Object.keys(KINDS) as Kind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {KINDS[kind].label} · {KINDS[kind].asset}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="until" label="Until" required error={shown('until')} help="The covenant lapses at the end of this day.">
                    <input {...bind('until')} type="date" min={new Date().toISOString().slice(0, 10)} />
                  </Field>
                </div>
                <div style={{ marginTop: 20 }}>
                  <Field
                    id="destinations"
                    label={draft.kind === 'airtime' ? 'Only these numbers' : 'Only these sites'}
                    error={shown('destinations')}
                    help={draft.kind === 'airtime' ? 'Optional. One per line. Leave empty to allow any Nigerian mobile number.' : 'Optional but wise. One origin per line, e.g. https://api.example.com. Leave empty to allow any site.'}
                  >
                    <textarea {...bind('destinations')} rows={3} placeholder={draft.kind === 'airtime' ? '0803 000 0000\n0812 000 0000' : 'https://api.example.com'} />
                  </Field>
                </div>
                {draft.kind === 'x402' ? (
                  <div style={{ marginTop: 20 }}>
                    <Field id="counterparties" label="Only pay these addresses" error={shown('counterparties')} help="Optional. The payTo addresses tolls may go to, one per line. For covenants that must never pay a stranger.">
                      <textarea {...bind('counterparties')} rows={2} placeholder="0x…" spellCheck={false} />
                    </Field>
                  </div>
                ) : null}
              </fieldset>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, paddingTop: 32, borderTop: '1px solid var(--line)' }}>
                <button type="submit" className="btn btn--gilt" disabled={busy} aria-busy={busy}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : <Seal size={18} />}
                  Seal the covenant
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => router.back()}>
                  Abandon
                </button>
              </div>
            </form>

            <div className="draft__preview">
              <Vellum d={draft} />
            </div>
          </div>
        </div>
      </main>
    </PageTransition>
  );
}
