'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Inscribe } from '@/components/Inscribe';
import { FORWARD, PageTransition } from '@/components/PageTransition';
import { Reveal } from '@/components/Reveal';
import { RoseWindow } from '@/components/RoseWindow';
import { useToast } from '@/components/Shell';
import { Status } from '@/components/Status';
import { Plus, Quatrefoil } from '@/components/icons';
import { addAmounts, compareAmounts, dayMonth, money, naira, ratio, roseFigure } from '@/lib/format';
import { useMeter, useResource } from '@/lib/meter';
import type { Mandate } from '@/lib/types';

const TITHES = ['1000', '5000', '10000'];

function Treasury() {
  const { client, demo } = useMeter();
  const balance = useResource('balance', (c) => c.balance());
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const tithe = async (amount: string) => {
    setBusy(amount);
    try {
      await client.credit(amount);
      balance.reload();
      toast(`${naira(amount)} laid in the treasury`);
    } finally {
      setBusy(null);
    }
  };

  const [whole, fraction] = naira(balance.data?.available ?? '0').replace('₦', '').split('.');
  return (
    <aside className="treasury" aria-labelledby="treasury-title">
      <p id="treasury-title" className="eyebrow eyebrow--gilt">
        The treasury
      </p>
      <p className="treasury__amount figure" aria-live="polite" aria-busy={balance.loading}>
        {balance.data === undefined ? (
          <span className="skeleton" style={{ display: 'inline-block', width: '6ch', height: '0.9em' }} aria-label="Loading balance" />
        ) : (
          <>
            <span className="currency">₦</span>
            {whole}
            <span className="muted" style={{ fontSize: '0.5em' }}>
              .{fraction}
            </span>
          </>
        )}
      </p>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: '1rem' }}>
        Available for your agents to draw upon
      </p>
      <div className="treasury__held">
        <span>Held for deeds in passage</span>
        <span className="figure">{balance.data === undefined ? '—' : naira(balance.data.reserved)}</span>
      </div>
      {(balance.data?.balances ?? [])
        .filter((b) => b.asset !== 'NGN')
        .map((b) => (
          <div key={b.asset}>
            <div className="treasury__held">
              <span>{b.asset} for web tolls</span>
              <span className="figure gilt" style={{ whiteSpace: 'nowrap' }}>
                {money(b.available, b.asset)}
              </span>
            </div>
            {compareAmounts(b.reserved, '0') > 0 ? (
              <div className="treasury__held" style={{ borderTop: 0, marginTop: 4, paddingTop: 0 }}>
                <span>Held for tolls awaiting the chain</span>
                <span className="figure" style={{ whiteSpace: 'nowrap' }}>
                  {money(b.reserved, b.asset)}
                </span>
              </div>
            ) : null}
          </div>
        ))}
      <div className="tithe">
        <p className="eyebrow">{demo ? 'Tithe (demonstration)' : 'Tithe (sandbox)'}</p>
        <div className="tithe__options">
          {TITHES.map((amount) => (
            <button key={amount} type="button" className="btn btn--small" onClick={() => tithe(amount)} disabled={busy !== null} aria-busy={busy === amount}>
              {busy === amount ? <span className="spinner" aria-hidden="true" /> : <Plus size={14} />}
              {naira(amount).replace('.00', '')}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Covenant({ mandate, i }: { mandate: Mandate; i: number }) {
  const used = ratio(mandate.exposure.today, mandate.limits.daily);
  const active = mandate.status === 'active';
  const seals = mandate.credentials.filter((c) => c.status === 'active').length;
  return (
    <Reveal i={i} className={`arch ${active ? '' : 'arch--dissolved'}`} as="article">
      <Link className="arch__link" href={`/mandate?id=${mandate.id}`} aria-label={`Open the covenant ${mandate.name}`} transitionTypes={FORWARD} data-cursor="Enter" />
      <Quatrefoil className="arch__crown" size={22} />
      <header className="arch__head">
        <Status status={mandate.status} />
        <h3 className="display display--card">{mandate.name}</h3>
        <p className="eyebrow" style={{ marginTop: 10 }}>
          {mandate.limits.allowed_categories.includes('x402') ? 'Paid web resources · USDC' : 'Airtime · NGN'}
        </p>
      </header>
      <div className="arch__rose">
        <RoseWindow
          size={172}
          used={used}
          {...roseFigure(mandate.exposure.daily_remaining, mandate.asset, 'left today')}
          description={`${money(mandate.exposure.today, mandate.asset)} of the ${money(mandate.limits.daily, mandate.asset)} daily limit used; ${money(mandate.exposure.daily_remaining, mandate.asset)} remains.`}
        />
      </div>
      <dl className="arch__terms">
        <div>
          <dt>Per deed</dt>
          <dd className="figure">{money(mandate.limits.per_transaction, mandate.asset)}</dd>
        </div>
        <div>
          <dt>Per day</dt>
          <dd className="figure">{money(mandate.limits.daily, mandate.asset)}</dd>
        </div>
        <div>
          <dt>Seals</dt>
          <dd>
            {seals} in service
          </dd>
        </div>
        <div>
          <dt>{active ? 'Until' : 'Dissolved'}</dt>
          <dd>{dayMonth(active ? mandate.expires_at : (mandate.revoked_at ?? mandate.expires_at))}</dd>
        </div>
      </dl>
    </Reveal>
  );
}

export default function Overview() {
  const mandates = useResource('mandates', (c) => c.mandates());
  const list = mandates.data ?? [];
  const active = list.filter((m) => m.status === 'active');

  return (
    <PageTransition>
      <main id="main" tabIndex={-1}>
        <div className="frame">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero__title">
              <p className="eyebrow eyebrow--gilt">Authority, lent to machines</p>
              <Inscribe text="Covenants" className="display--hero" />
            </div>
            <div className="hero__lede">
              <p className="lede">
                Bind what your agents may spend. Watch every deed they do in your name. Break the seal the moment you wish.
              </p>
              <p className="muted" style={{ margin: 0, maxWidth: '46ch' }}>
                A covenant is a mandate: limits an AI agent cannot pass, checked in order before a single kobo is held, and a record of everything it does.
              </p>
            </div>
            <Treasury />
          </section>

          <section className="vigil" aria-label="At a glance">
            {[
              ['Covenants in force', String(active.length)],
              ['Seals in service', String(active.reduce((n, m) => n + m.credentials.filter((c) => c.status === 'active').length, 0))],
              ['Spent today', naira(addAmounts(active.filter((m) => m.asset === 'NGN').map((m) => m.exposure.today)))],
              ['Deeds in passage', String(active.reduce((n, m) => n + m.exposure.in_flight, 0))],
            ].map(([label, value]) => (
              <div key={label} className="vigil__item">
                <span className="eyebrow">{label}</span>
                <span className="vigil__value figure">{mandates.data === undefined ? '—' : value}</span>
              </div>
            ))}
          </section>

          <div className="rule" aria-hidden="true">
            <Quatrefoil size={18} />
          </div>

          <section aria-labelledby="covenants-title">
            <div className="section-head">
              <div>
                <h2 id="covenants-title" className="display display--section">
                  The <span className="gilt">nave</span>
                </h2>
                <p className="muted">Each covenant an arch; each arch a limit your agents cannot pass.</p>
              </div>
              <Link href="/mandates/new" className="btn btn--gilt" transitionTypes={FORWARD}>
                <Plus size={16} />
                Draw a covenant
              </Link>
            </div>

            {mandates.error !== undefined ? (
              <p className="alert" role="alert">
                The covenants could not be read: {mandates.error.message}
                <button type="button" className="btn btn--small" onClick={mandates.reload} style={{ marginLeft: 'auto' }}>
                  Try again
                </button>
              </p>
            ) : (
              <div className="nave">
                {mandates.data === undefined
                  ? [0, 1, 2].map((n) => <div key={n} className="arch skeleton" aria-hidden="true" />)
                  : list.map((mandate, i) => <Covenant key={mandate.id} mandate={mandate} i={i} />)}
                {mandates.data !== undefined && list.length === 0 ? (
                  <div className="arch arch--empty">
                    <Quatrefoil size={40} className="gilt" />
                    <p className="display display--card">No covenant yet drawn</p>
                    <p className="muted">An agent has no authority until you grant it one.</p>
                    <Link href="/mandates/new" className="btn btn--gilt" transitionTypes={FORWARD}>
                      Draw the first
                    </Link>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </main>
    </PageTransition>
  );
}
