'use client';

import { useState } from 'react';
import { useToast } from './Shell';
import { Copy, Warning } from './icons';

/** The seal itself: two halves, so it can crack along a jagged seam. */
function SealArt() {
  const edge = 'M100 8 L112 16 L127 13 L134 27 L149 31 L150 47 L162 57 L157 72 L165 86 L156 99 L160 114 L148 124 L147 140 L132 145 L125 159 L110 157 L100 168 L90 157 L75 159 L68 145 L53 140 L52 124 L40 114 L44 99 L35 86 L43 72 L38 57 L50 47 L51 31 L66 27 L73 13 L88 16 Z';
  const seam = 'M100 8 L96 40 L106 62 L94 88 L108 112 L97 138 L100 168';
  return (
    <svg className="wax__seal" viewBox="0 0 200 176" aria-hidden="true">
      <defs>
        <radialGradient id="wax" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#c23a45" />
          <stop offset="0.55" stopColor="#8f1a29" />
          <stop offset="1" stopColor="#4d0b14" />
        </radialGradient>
        <clipPath id="left">
          <path d={`${seam} L0 176 L0 0 Z`} />
        </clipPath>
        <clipPath id="right">
          <path d={`${seam} L200 176 L200 0 Z`} />
        </clipPath>
      </defs>
      {(['left', 'right'] as const).map((half) => (
        <g key={half} className={`wax__half wax__half--${half}`} clipPath={`url(#${half})`} style={{ transformOrigin: '100px 88px' }}>
          <path d={edge} fill="url(#wax)" />
          <circle cx="100" cy="88" r="46" fill="none" stroke="#5c0f19" strokeWidth="3" />
          <circle cx="100" cy="88" r="40" fill="none" stroke="#d8606b" strokeOpacity="0.35" strokeWidth="1" />
          <text x="100" y="108" textAnchor="middle" fontFamily="var(--font-display)" fontSize="58" fill="#4d0b14" fillOpacity="0.85">
            M
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * A new credential, shown exactly once. The owner breaks the seal to read it;
 * after this page the secret exists only as a hash.
 */
export function WaxSeal({ token, label, apiUrl }: { token: string; label: string; apiUrl: string }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  };

  const config = JSON.stringify(
    { mcpServers: { meter: { command: 'node', args: ['/path/to/meter/apps/mcp/src/index.ts'], env: { METER_API_URL: apiUrl, METER_AGENT_CREDENTIAL: token } } } },
    null,
    2,
  );

  return (
    <section className={`wax ${broken ? 'is-broken' : ''}`} aria-labelledby="wax-title">
      <h3 id="wax-title" className="sr-only">
        New seal for {label}
      </h3>
      {!open ? (
        <button
          type="button"
          className="wax__button"
          data-cursor="Break"
          onClick={() => {
            setBroken(true);
            setTimeout(() => setOpen(true), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 520);
          }}
        >
          <SealArt />
          <span className="eyebrow eyebrow--gilt">Break the seal to read the secret</span>
          <span className="muted" style={{ fontStyle: 'italic' }}>
            Sealed for “{label}”. It will be shown once, and never again.
          </span>
        </button>
      ) : (
        <div className="wax__letter">
          <p className="eyebrow eyebrow--gilt">The secret of “{label}”</p>
          <div className="token">
            <code>{token}</code>
            <button type="button" className="btn btn--gilt btn--small" onClick={() => copy(token, 'Secret')}>
              <Copy size={16} />
              Copy
            </button>
          </div>
          <div className="alert" style={{ marginTop: 16 }}>
            <Warning size={18} />
            <span>Keep it as you would a key. Meter stores only its hash; if it is lost, forge a new seal and break this one.</span>
          </div>
          <p className="field__help" style={{ marginTop: 24 }}>
            For Claude Desktop, add this to its MCP configuration:
          </p>
          <pre className="config">{config}</pre>
          <button type="button" className="btn btn--small" style={{ marginTop: 12 }} onClick={() => copy(config, 'Configuration')}>
            <Copy size={16} />
            Copy configuration
          </button>
        </div>
      )}
    </section>
  );
}
