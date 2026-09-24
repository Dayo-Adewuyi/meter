'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { Confirm } from '@/components/Confirm';
import { Inscribe } from '@/components/Inscribe';
import { BACK, FORWARD, PageTransition } from '@/components/PageTransition';
import { Reveal } from '@/components/Reveal';
import { RoseWindow } from '@/components/RoseWindow';
import { useToast } from '@/components/Shell';
import { Status } from '@/components/Status';
import { WaxSeal } from '@/components/WaxSeal';
import { ArrowLeft, Chevron, Quatrefoil, Seal } from '@/components/icons';
import { dayMonth, longDate, maskPhone, money, naira, ratio, relative, roman, roseFigure, shortAddress, span } from '@/lib/format';
import { useMeter, useResource } from '@/lib/meter';
import { ApiError, type Credential, type IssuedCredential, type Mandate } from '@/lib/types';

const API_URL = process.env.NEXT_PUBLIC_METER_API_URL ?? 'http://localhost:3001';

function Articles({ m }: { m: Mandate }) {
  const items = [
    ['The single deed', `No purchase greater than ${money(m.limits.per_transaction, m.asset)}.`],
    ['The day', `No more than ${money(m.limits.daily, m.asset)} between one Lagos midnight and the next.`],
    ['The whole', `No more than ${money(m.limits.lifetime, m.asset)} for the life of the covenant.`],
    ['The pace', `At most ${m.limits.velocity.max_count} deeds in ${span(m.limits.velocity.window_secs)}; never more than ${m.limits.max_in_flight} in passage at once.`],
    [
      'The repetition',
      m.limits.duplicate_window_secs === 0
        ? 'Identical deeds are allowed back to back.'
        : `The same number and amount twice within ${span(m.limits.duplicate_window_secs)} is refused, unless the user asks for it again.`,
    ],
    m.limits.allowed_categories.includes('x402')
      ? [
          'The reach',
          `Paid web resources (x402), settled in USDC on Base Sepolia, ${
            m.limits.allowed_destinations === null ? 'from any origin' : `from ${m.limits.allowed_destinations.join(', ')} alone`
          }${m.limits.allowed_counterparties == null ? '' : `, paid only to ${m.limits.allowed_counterparties.map(shortAddress).join(', ')}`}. Nothing is charged until the chain has made the payment final.`,
        ]
      : [
          'The reach',
          `${m.limits.allowed_categories.join(', ').replace(/^./, (c) => c.toUpperCase())} only, ${
            m.limits.allowed_destinations === null ? 'to any Nigerian mobile number' : `to ${m.limits.allowed_destinations.map(maskPhone).join(', ')} alone`
          }.`,
        ],
    ['The term', m.status === 'active' ? `In force until ${longDate(m.expires_at)}.` : `Dissolved ${longDate(m.revoked_at ?? m.expires_at)}.`],
  ];
  return (
    <ol className="articles">
      {(items as [string, string][]).map(([title, body], i) => (
        <li key={title}>
          <span className="articles__numeral" aria-hidden="true">
            {roman(i + 1)}
          </span>
          <div>
            <h3 className="articles__title">{title}</h3>
            <p className="articles__body">{body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Seals({ m, onChange }: { m: Mandate; onChange: () => void }) {
  const { client } = useMeter();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [forging, setForging] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [breaking, setBreaking] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forge = async (event: FormEvent) => {
    event.preventDefault();
    if (label.trim().length === 0) {
      setError('Name the agent that will bear this seal.');
      return;
    }
    setForging(true);
    setError(null);
    try {
      setIssued(await client.issueCredential(m.id, label.trim()));
      setLabel('');
      onChange();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'The seal could not be forged.');
    } finally {
      setForging(false);
    }
  };

  const breakSeal = async () => {
    if (breaking === null) return;
    setBusy(true);
    try {
      await client.revokeCredential(breaking.id);
      toast(`The seal of “${breaking.label}” is broken`);
      setBreaking(null);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="seals-title">
      <h2 id="seals-title" className="display display--section">
        The <span className="gilt">seals</span>
      </h2>
      <p className="muted" style={{ margin: '8px 0 24px' }}>
        Each seal is one agent&apos;s credential. Break one and that agent can do nothing more.
      </p>
      <ul className="seals">
        {m.credentials.length === 0 ? <li className="empty">No seal yet. Forge one to let an agent act.</li> : null}
        {m.credentials.map((c) => (
          <li key={c.id} className={`seal-row ${c.status === 'revoked' ? 'seal-row--revoked' : ''}`}>
            <Seal size={36} className="seal-row__glyph" />
            <div>
              <p className="seal-row__name">{c.label}</p>
              <p className="seal-row__meta">
                <span className="mono">mtr_agt_{c.public_id}_••••</span> · {c.last_used_at === null ? 'never used' : `last used ${relative(c.last_used_at)}`}
              </p>
            </div>
            {c.status === 'active' && m.status === 'active' ? (
              <button type="button" className="btn btn--blood btn--small" onClick={() => setBreaking(c)}>
                Break
              </button>
            ) : (
              <Status status={c.status} />
            )}
          </li>
        ))}
      </ul>

      {m.status === 'active' ? (
        <form className="forge" onSubmit={forge} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="seal-label">
              Forge a seal for
            </label>
            <div className="input" data-invalid={error !== null}>
              <input id="seal-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Desktop" maxLength={80} autoComplete="off" aria-describedby={error === null ? undefined : 'seal-error'} />
            </div>
            {error === null ? null : (
              <p className="field__error" id="seal-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <button type="submit" className="btn btn--gilt" disabled={forging} aria-busy={forging}>
            {forging ? <span className="spinner" aria-hidden="true" /> : <Seal size={18} />}
            Forge
          </button>
        </form>
      ) : null}

      {issued === null ? null : <WaxSeal key={issued.id} token={issued.token} label={issued.label} apiUrl={API_URL} />}

      <Confirm
        open={breaking !== null}
        title={`Break the seal of “${breaking?.label ?? ''}”?`}
        confirmLabel="Break the seal"
        busy={busy}
        onConfirm={breakSeal}
        onCancel={() => setBreaking(null)}
      >
        <p style={{ margin: 0 }}>
          This agent loses all authority at once. Deeds it has asked for but that have not yet been sent are cancelled and their money returned.
          Deeds already sent are left to finish.
        </p>
      </Confirm>
    </section>
  );
}

function Deeds({ mandateId }: { mandateId: string }) {
  const deeds = useResource(`deeds:${mandateId}`, (c) => c.purchases(mandateId));
  return (
    <section aria-labelledby="deeds-title">
      <h2 id="deeds-title" className="display display--section">
        The ledger of <span className="gilt">deeds</span>
      </h2>
      <p className="muted" style={{ margin: '8px 0 24px' }}>
        Everything done under this covenant, newest first. Open a deed to read its chronicle.
      </p>
      {deeds.data === undefined ? (
        <div className="skeleton" style={{ height: 240 }} aria-label="Loading deeds" />
      ) : deeds.data.length === 0 ? (
        <p className="empty">No deed has been done under this covenant.</p>
      ) : (
        <table className="deeds">
          <thead>
            <tr>
              <th scope="col">Deed</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col">
                <span className="sr-only">Chronicle</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {deeds.data.map((p) => (
              <tr key={p.purchase_id}>
                <td>
                  <span className="figure">
                    {p.network.toUpperCase()} · {maskPhone(p.destination)}
                  </span>
                  <span className="deeds__intent">“{p.intent}”</span>
                  <span className="muted" style={{ fontSize: '0.9rem' }}>
                    {relative(p.created_at)}
                    {p.credential_label === undefined ? '' : ` · by ${p.credential_label}`}
                  </span>
                </td>
                <td>
                  <Status status={p.status} />
                </td>
                <td className="num figure">{naira(p.amount)}</td>
                <td>
                  <Link href={`/purchase?id=${p.purchase_id}`} aria-label={`Chronicle of the ${naira(p.amount)} deed`} transitionTypes={FORWARD} data-cursor="Read">
                    Chronicle <Chevron size={14} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function X402Ledger({ mandateId }: { mandateId: string }) {
  const payments = useResource(`x402:${mandateId}`, (c) => c.x402Payments(mandateId));
  return (
    <section aria-labelledby="x402-title">
      <h2 id="x402-title" className="display display--section">
        The ledger of <span className="gilt">tolls</span>
      </h2>
      <p className="muted" style={{ margin: '8px 0 24px' }}>
        Each toll is a signed promise to pay one web resource. It is charged only when the chain shows it spent, and returned if it expires unspent.
      </p>
      {payments.data === undefined ? (
        <div className="skeleton" style={{ height: 240 }} aria-label="Loading payments" />
      ) : payments.data.length === 0 ? (
        <p className="empty">No toll has been paid under this covenant.</p>
      ) : (
        <table className="deeds">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col">
                <span className="sr-only">Chronicle</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {payments.data.map((p) => (
              <tr key={p.payment_id}>
                <td>
                  <span className="figure">
                    {p.method} /{new URL(p.resource_url).pathname.split('/').filter(Boolean).pop() ?? ''}
                  </span>
                  <span className="deeds__intent">“{p.intent}”</span>
                  <span className="muted" style={{ fontSize: '0.9rem' }}>
                    {new URL(p.resource_url).host} · {relative(p.created_at)}
                    {p.credential_label === undefined ? '' : ` · by ${p.credential_label}`}
                  </span>
                </td>
                <td>
                  <Status status={p.status} />
                </td>
                <td className="num figure">{money(p.amount, p.asset)}</td>
                <td>
                  <Link href={`/purchase?id=${p.payment_id}&kind=x402`} aria-label={`Chronicle of the ${money(p.amount, p.asset)} toll`} transitionTypes={FORWARD} data-cursor="Read">
                    Chronicle <Chevron size={14} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CovenantPage() {
  const params = useSearchParams();
  const id = params.get('id');
  const { client } = useMeter();
  const toast = useToast();
  const mandate = useResource(id === null ? null : `mandate:${id}`, (c) => c.mandate(id!));
  const [dissolving, setDissolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  if (id === null) return <p className="empty">No covenant was named.</p>;
  if (mandate.error !== undefined) {
    return (
      <p className="alert" role="alert" style={{ marginTop: 48 }}>
        This covenant could not be read: {mandate.error.message}
      </p>
    );
  }
  const m = mandate.data;
  if (m === undefined) return <div className="skeleton" style={{ height: 480, marginTop: 64 }} aria-label="Loading covenant" />;

  const dissolve = async () => {
    setBusy(true);
    try {
      await client.revokeMandate(m.id, reason.trim() || 'dissolved by owner');
      setDissolving(false);
      toast('The covenant is dissolved');
      mandate.reload();
    } finally {
      setBusy(false);
    }
  };

  const today = ratio(m.exposure.today, m.limits.daily);
  const lifetime = ratio(m.exposure.lifetime, m.limits.lifetime);
  const inFlight = m.exposure.in_flight / m.limits.max_in_flight;

  return (
    <>
      <header className="page-head">
        <div className="page-head__meta">
          <Status status={m.status} />
          <span>Drawn {dayMonth(m.created_at)}</span>
          <span>{m.status === 'active' ? `In force until ${longDate(m.expires_at)}` : `Dissolved ${longDate(m.revoked_at ?? m.expires_at)}`}</span>
        </div>
        <Inscribe text={m.name} className="display--page" />
        {params.get('drawn') === '1' && m.credentials.length === 0 ? (
          <p className="lede">The covenant is sealed. Forge a seal below to give an agent its authority.</p>
        ) : null}
      </header>

      <section className="clerestory" aria-label="Limits used">
        <div className="clerestory__bay">
          <RoseWindow
            used={today}
            {...roseFigure(m.exposure.daily_remaining, m.asset, 'left today')}
            description={`${money(m.exposure.today, m.asset)} of ${money(m.limits.daily, m.asset)} used today; ${money(m.exposure.daily_remaining, m.asset)} remains.`}
          />
          <p>
            <span className="figure">{money(m.exposure.today, m.asset)}</span> <span className="muted">of {money(m.limits.daily, m.asset)} today</span>
            <br />
            <span className="muted">renews {relative(m.exposure.daily_resets_at)}</span>
          </p>
        </div>
        <div className="clerestory__bay">
          <RoseWindow
            used={lifetime}
            {...roseFigure(m.exposure.lifetime_remaining, m.asset, 'left in all')}
            description={`${money(m.exposure.lifetime, m.asset)} of ${money(m.limits.lifetime, m.asset)} used over the covenant's life.`}
          />
          <p>
            <span className="figure">{money(m.exposure.lifetime, m.asset)}</span> <span className="muted">of {money(m.limits.lifetime, m.asset)} in all</span>
          </p>
        </div>
        <div className="clerestory__bay">
          <RoseWindow
            used={inFlight}
            value={`${m.exposure.in_flight} / ${m.limits.max_in_flight}`}
            label="in passage"
            description={`${m.exposure.in_flight} of at most ${m.limits.max_in_flight} deeds are in passage now.`}
          />
          <p>
            <span className="muted">Money for these is held, never guessed.</span>
          </p>
        </div>
      </section>

      <div className="rule" aria-hidden="true">
        <Quatrefoil size={18} />
      </div>

      <Reveal as="section" className="stack" aria-labelledby="articles-title">
        <h2 id="articles-title" className="display display--section">
          The <span className="gilt">articles</span>
        </h2>
        <Articles m={m} />
      </Reveal>

      <div className="rule" aria-hidden="true">
        <Quatrefoil size={18} />
      </div>

      <div className="bays">
        <Reveal>
          <Seals m={m} onChange={mandate.reload} />
        </Reveal>
        <Reveal i={1}>
          {m.limits.allowed_categories.includes('x402') ? <X402Ledger mandateId={m.id} /> : <Deeds mandateId={m.id} />}
        </Reveal>
      </div>

      {m.status === 'active' ? (
        <>
          <div className="rule" aria-hidden="true">
            <Quatrefoil size={18} />
          </div>
          <section aria-labelledby="dissolve-title" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 id="dissolve-title" className="display display--section" style={{ color: 'var(--blood-hi)' }}>
                Dissolve
              </h2>
              <p className="muted" style={{ margin: '8px 0 0', maxWidth: '52ch' }}>
                Breaks every seal and cancels every deed not yet sent. Deeds already with the provider finish as they must.
              </p>
            </div>
            <button type="button" className="btn btn--blood" onClick={() => setDissolving(true)}>
              Dissolve the covenant
            </button>
          </section>
          <Confirm open={dissolving} title={`Dissolve “${m.name}”?`} confirmLabel="Dissolve" busy={busy} onConfirm={dissolve} onCancel={() => setDissolving(false)}>
            <div className="field">
              <label className="field__label" htmlFor="dissolve-reason">
                Reason, for the record
              </label>
              <div className="input">
                <input id="dissolve-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="No longer needed" maxLength={280} />
              </div>
            </div>
          </Confirm>
        </>
      ) : null}
    </>
  );
}

export default function Page() {
  return (
    <PageTransition>
      <main id="main" tabIndex={-1}>
        <div className="frame">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/" transitionTypes={BACK}>
              <ArrowLeft size={16} style={{ marginRight: 8 }} />
              Covenants
            </Link>
          </nav>
          <Suspense fallback={<div className="skeleton" style={{ height: 480, marginTop: 64 }} />}>
            <CovenantPage />
          </Suspense>
        </div>
      </main>
    </PageTransition>
  );
}
