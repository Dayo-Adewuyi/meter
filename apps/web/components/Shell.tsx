'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UserButton } from '@clerk/react';
import { Cursor } from './Cursor';
import { BACK, FORWARD } from './PageTransition';
import { Check, Quatrefoil } from './icons';
import { DEMO, MeterProvider } from '@/lib/meter';

const ToastContext = createContext<(message: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

function Header() {
  const pathname = usePathname();
  const current = (href: string) => (pathname === href ? 'page' : undefined);
  return (
    <header className="header" style={{ viewTransitionName: 'site-header' }}>
      <div className="frame header__inner">
        <Link href="/" className="wordmark" aria-label="Meter, the covenants" transitionTypes={BACK}>
          <Quatrefoil size={26} />
          Meter
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/" className="nav__link" aria-current={current('/')} transitionTypes={BACK}>
            Covenants
          </Link>
          <Link href="/mandates/new" className="nav__link" aria-current={current('/mandates/new')} transitionTypes={FORWARD}>
            Draw a covenant
          </Link>
        </nav>
        <span className="mode" title={DEMO ? 'Demonstration data; nothing leaves this tab.' : 'Sandbox: no real money moves.'}>
          {DEMO ? 'Demonstration' : 'Sandbox'}
        </span>
        {DEMO ? null : <UserButton />}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="frame footer__inner">
        <span className="footer__motto">Nothing moves on a guess.</span>
        <span>Every covenant bounded. Every deed witnessed. Every seal breakable.</span>
      </div>
    </footer>
  );
}

function Gate({ signIn }: { signIn: ReactNode }) {
  return (
    <main id="main" className="gate page-enter">
      <div className="stack" style={{ ['--stack' as string]: '20px' }}>
        <p className="eyebrow eyebrow--gilt">Owners only</p>
        <h1 className="display display--page">Enter the vault</h1>
        <p className="lede" style={{ marginInline: 'auto' }}>
          Sign in to draw covenants for your agents and to read what they have done in your name.
        </p>
      </div>
      {signIn}
    </main>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((message: string) => {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3600);
  }, []);
  const pathname = usePathname();

  // Route change: move focus to the content for screen-reader users (§ focus-on-route-change).
  useEffect(() => {
    scrollTo({ top: 0 });
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <ToastContext.Provider value={say}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Cursor />
      <MeterProvider
        gate={(signIn) => (
          <>
            <Header />
            <Gate signIn={signIn} />
          </>
        )}
      >
        <Header />
        {children}
        <Footer />
      </MeterProvider>
      <div aria-live="polite" role="status">
        {toast === null ? null : (
          <div className="toast">
            <Check size={18} />
            {toast}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
