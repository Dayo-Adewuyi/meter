'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

type Mode = 'idle' | 'link' | 'label' | 'text';

const INTERACTIVE = 'a, button, [role="button"], label, select, summary, [data-cursor]';
const TEXT = 'input:not([type="checkbox"]):not([type="radio"]):not([type="date"]), textarea';

/**
 * A gilt diamond that sits exactly on the pointer, a halo that follows with a
 * little lag, and the candlelight behind both. The halo swells over anything
 * clickable and speaks a word over targets that set data-cursor="…".
 * Fine pointers only; touch and reduced-motion users keep the system cursor.
 */
export function Cursor() {
  const dot = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const [d, r, l, c] = [dot.current, ring.current, label.current, light.current];
    if (d === null || r === null || l === null || c === null) return;
    const fine = matchMedia('(pointer: fine)').matches;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || calm) return;
    document.documentElement.classList.add('has-cursor');

    let tx = innerWidth / 2;
    let ty = innerHeight / 3;
    let rx = tx;
    let ry = ty;
    let lx = tx;
    let ly = ty;
    let frame = 0;
    let mode: Mode = 'idle';

    const tick = () => {
      // The halo trails the diamond; the candle trails further still.
      rx += (tx - rx) * 0.2;
      ry += (ty - ry) * 0.2;
      lx += (tx - lx) * 0.08;
      ly += (ty - ly) * 0.08;
      r.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      c.style.setProperty('--x', `${lx}px`);
      c.style.setProperty('--y', `${ly}px`);
      const settled = Math.abs(tx - rx) + Math.abs(ty - ry) + Math.abs(tx - lx) + Math.abs(ty - ly) < 0.5;
      frame = settled ? 0 : requestAnimationFrame(tick);
    };

    const setMode = (next: Mode, text = '') => {
      if (next === mode && l.textContent === text) return;
      mode = next;
      r.dataset.mode = next;
      d.dataset.mode = next;
      l.textContent = text;
    };

    const move = (event: PointerEvent) => {
      tx = event.clientX;
      ty = event.clientY;
      d.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      document.documentElement.classList.remove('cursor-away');
      const target = event.target instanceof Element ? event.target : null;
      const labelled = target?.closest<HTMLElement>('[data-cursor]');
      if (target?.closest(TEXT)) setMode('text');
      else if (labelled && !labelled.matches(':disabled')) setMode('label', labelled.dataset.cursor ?? '');
      else if (target?.closest(INTERACTIVE) && !target.closest(':disabled')) setMode('link');
      else setMode('idle');
      if (frame === 0) frame = requestAnimationFrame(tick);
    };
    const down = () => document.documentElement.classList.add('cursor-down');
    const up = () => document.documentElement.classList.remove('cursor-down');
    const away = () => document.documentElement.classList.add('cursor-away');

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerdown', down, { passive: true });
    addEventListener('pointerup', up, { passive: true });
    document.documentElement.addEventListener('pointerleave', away);
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerdown', down);
      removeEventListener('pointerup', up);
      document.documentElement.removeEventListener('pointerleave', away);
      document.documentElement.classList.remove('has-cursor');
      cancelAnimationFrame(frame);
    };
  }, []);

  // A new page may have moved a link out from under a still pointer.
  useEffect(() => {
    ring.current?.setAttribute('data-mode', 'idle');
    dot.current?.setAttribute('data-mode', 'idle');
  }, [pathname]);

  return (
    <>
      <div ref={light} className="candle" aria-hidden="true" />
      <div ref={ring} className="cursor-ring" data-mode="idle" aria-hidden="true">
        <span ref={label} className="cursor-ring__label" />
      </div>
      <div ref={dot} className="cursor-dot" data-mode="idle" aria-hidden="true" />
    </>
  );
}
