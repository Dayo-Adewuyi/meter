'use client';

import { ClerkProvider, SignIn, useAuth } from '@clerk/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { demoClient } from './demo-client';
import { httpClient } from './http-client';
import type { MeterClient } from './types';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const API_URL = process.env.NEXT_PUBLIC_METER_API_URL ?? 'http://localhost:3001';

/** Demo when asked for, or when there is no Clerk key to sign in with. */
export const DEMO = process.env.NEXT_PUBLIC_METER_DEMO === 'true' || PUBLISHABLE_KEY === undefined || PUBLISHABLE_KEY === '';

interface MeterContext {
  readonly client: MeterClient;
  readonly demo: boolean;
}

const Context = createContext<MeterContext | null>(null);

export function useMeter(): MeterContext {
  const value = useContext(Context);
  if (value === null) throw new Error('useMeter outside MeterProvider');
  return value;
}

function LiveClient({ children, gate }: { children: ReactNode; gate: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const client = useMemo(() => httpClient(API_URL, () => getToken()), [getToken]);
  if (!isLoaded) return null;
  if (!isSignedIn) return gate;
  return <Context.Provider value={{ client, demo: false }}>{children}</Context.Provider>;
}

export function MeterProvider({ children, gate }: { children: ReactNode; gate: (signIn: ReactNode) => ReactNode }) {
  const demo = useMemo(() => (DEMO ? demoClient() : null), []);
  if (demo !== null) return <Context.Provider value={{ client: demo, demo: true }}>{children}</Context.Provider>;
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY!}
      appearance={{
        variables: {
          colorPrimary: '#c8a15a',
          colorBackground: '#14110f',
          colorForeground: '#ece3d0',
          colorPrimaryForeground: '#0b0a09',
          colorDanger: '#e0606c',
          colorInput: '#0b0a09',
          colorInputForeground: '#ece3d0',
          colorMutedForeground: '#a39a8b',
          fontFamily: 'var(--font-body)',
          borderRadius: '2px',
        },
      }}
    >
      <LiveClient gate={gate(<SignIn routing="hash" />)}>{children}</LiveClient>
    </ClerkProvider>
  );
}

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  reload(): void;
}

/** Load once per key, reload on demand. Stale responses from an earlier key are dropped. */
export function useResource<T>(key: string | null, load: (client: MeterClient) => Promise<T>): Resource<T> {
  const { client } = useMeter();
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: key !== null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    loadRef.current(client).then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [client, key, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
