'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Inscribe } from '@/components/Inscribe';
import { BACK, PageTransition } from '@/components/PageTransition';
import { Reveal } from '@/components/Reveal';
import { Status } from '@/components/Status';
import { ArrowLeft, Bell, Check, Coin, Cross, Scroll, Seal } from '@/components/icons';
import { clock, longDate, naira } from '@/lib/format';
import { useResource } from '@/lib/meter';
import type { TimelineEntry } from '@/lib/types';

const STATUS: Record<string, string> = {
  delivered: 'delivered',
  rejected: 'failed',
  declined: 'declined',
  expired: 'expired',
};

const KIND = {
  decision: { label: 'Judgement', Icon: Scroll },
  ledger: { label: 'Ledger', Icon: Coin },
  provider: { label: 'Provider', Icon: Bell },
  purchase: { label: 'Passage', Icon: Seal },
} as const;

const words = (value: unknown) => String(value ?? '').replaceAll('_', ' ');

const LEDGER: Record<string, string> = {
  reserve: 'held from the treasury',
  capture: 'paid to the provider',
  release: 'returned to the treasury',
};

function Checks({ checks }: { checks: string }) {
  const items = checks
    .split(/\s(?=[a-z_]+ [✓✗])/)
    .map((item) => item.trim().split(' '))
    .filter((parts) => parts.length === 2);
  return (
    <ul className="checks" aria-label="Checks, in the order they ran">
      {items.map(([name, mark]) => (
        <li key={name} data-passed={mark === '✓'}>
          {mark === '✓' ? <Check size={12} /> : <Cross size={12} />}
          {words(name)}
          <span className="sr-only">{mark === '✓' ? 'passed' : 'failed'}</span>
        </li>
      ))}
    </ul>
  );
}

function Entry({ entry, i }: { entry: TimelineEntry; i: number }) {
  const { label, Icon } = KIND[entry.kind];
  const d = entry.detail;
  let text: React.ReactNode;
  switch (entry.kind) {
    case 'decision':
      text =
        d.outcome === 'approved' ? (
          <>Every article held. The deed was <strong>approved</strong>.</>
        ) : (
          <>
            The deed was <strong style={{ color: 'var(--blood-hi)' }}>denied</strong>: {words(d.reason_code).toLowerCase()}.
          </>
        );
      break;
    case 'ledger':
      text = (
        <>
          <span className="figure">{naira(String(d.amount))}</span> {LEDGER[String(d.type)] ?? words(d.type)}
        </>
      );
      break;
    case 'provider':
      text = (
        <>
          {d.call === 'send' ? 'Sent to the provider' : 'Asked the provider again'}
          <span className="arrow" aria-hidden="true">→</span>
          <strong>{words(d.kind)}</strong>
          {d.reason === undefined ? null : <span className="muted"> ({String(d.reason)})</span>}
          {d.code === undefined ? null : <span className="muted"> · {words(d.code).toLowerCase()}</span>}
          {d.provider_reference === undefined || d.provider_reference === null ? null : <span className="mono muted"> · {String(d.provider_reference)}</span>}
        </>
      );
      break;
    case 'purchase':
      text = (
        <>
          <span className="muted">{words(d.from) || '∅'}</span>
          <span className="arrow" aria-hidden="true">→</span>
          <span className="sr-only"> to </span>
          {words(d.to)}
          <span className="muted"> · {String(d.actor).startsWith('agent:') ? 'by the agent' : String(d.actor).startsWith('operator:') ? 'by an operator' : 'by the worker'}, {words(d.reason)}</span>
        </>
      );
      break;
  }
  return (
    <Reveal as="li" i={i} className={`chronicle__entry chronicle__entry--${entry.kind}`}>
      <time className="chronicle__time" dateTime={entry.at}>
        {clock(entry.at)}
      </time>
      <span className="chronicle__node" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="chronicle__body">
        <p className="chronicle__kind">{label}</p>
        <p className="chronicle__text">{text}</p>
        {entry.kind === 'decision' && typeof d.checks === 'string' ? <Checks checks={d.checks} /> : null}
      </div>
    </Reveal>
  );
}

function Chronicle() {
  const id = useSearchParams().get('id');
  const timeline = useResource(id === null ? null : `timeline:${id}`, (c) => c.timeline(id!));
  if (id === null) return <p className="empty">No deed was named.</p>;
  if (timeline.error !== undefined) {
    return (
      <p className="alert" role="alert" style={{ marginTop: 48 }}>
        This chronicle could not be read: {timeline.error.message}
      </p>
    );
  }
  const t = timeline.data;
  if (t === undefined) return <div className="skeleton" style={{ height: 520, marginTop: 64 }} aria-label="Loading chronicle" />;
  const p = t.purchase;

  return (
    <>
      <header className="page-head">
        <div className="page-head__meta">
          <Status status={STATUS[p.delivery_status] ?? 'processing'} />
          <span>{longDate(p.created_at)}</span>
          <span className="mono">{t.correlation_id.slice(0, 8)}</span>
        </div>
        <Inscribe text="Chronicle" className="display--page" />
      </header>

      <figure className="petition">
        <figcaption className="eyebrow eyebrow--gilt">The agent&apos;s petition, in its own words</figcaption>
        <blockquote>{p.intent}</blockquote>
      </figure>

      <dl className="facts">
        <div>
          <dt>Sum</dt>
          <dd className="figure">{naira(p.amount)}</dd>
        </div>
        <div>
          <dt>Airtime for</dt>
          <dd className="figure">
            {p.network.toUpperCase()} · {p.destination}
          </dd>
        </div>
        <div>
          <dt>Borne by</dt>
          <dd>{p.credential_label}</dd>
        </div>
      </dl>

      <div className="rule" aria-hidden="true" />

      <section aria-labelledby="chronicle-title">
        <h2 id="chronicle-title" className="display display--section" style={{ marginBottom: 32 }}>
          What was <span className="gilt">witnessed</span>
        </h2>
        <ol className="chronicle">
          {t.entries.map((entry, i) => (
            <Entry key={`${entry.at}-${i}`} entry={entry} i={i} />
          ))}
        </ol>
      </section>
    </>
  );
}

export default function Page() {
  return (
    <PageTransition>
      <main id="main" tabIndex={-1}>
        <div className="frame">
          <nav className="crumbs" aria-label="Breadcrumb">
            <button type="button" className="btn btn--quiet" style={{ paddingLeft: 0 }} onClick={() => history.back()}>
              <ArrowLeft size={16} />
              Back
            </button>
            <span aria-hidden="true">/</span>
            <Link href="/" transitionTypes={BACK}>
            Covenants
          </Link>
          </nav>
          <Suspense fallback={<div className="skeleton" style={{ height: 520, marginTop: 64 }} />}>
            <Chronicle />
          </Suspense>
        </div>
      </main>
    </PageTransition>
  );
}
