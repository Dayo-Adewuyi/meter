import { ViewTransition } from 'react';

/**
 * Route transitions (Next 16 + React ViewTransition). Forward navigations open
 * the new page through a widening pointed arch; back navigations close it.
 * Untagged ones (browser back, redirects) crossfade. Lives in each page, not
 * the layout: layouts persist, so enter/exit never fire there.
 */
const MOTION = { 'nav-forward': 'arch-open', 'nav-back': 'arch-close', default: 'veil' };

export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter={MOTION} exit={MOTION} default="none">
      {children}
    </ViewTransition>
  );
}

export const FORWARD = ['nav-forward'];
export const BACK = ['nav-back'];
