'use client';

import { type ElementType, type HTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';

/** Rises into view once, as it enters the viewport. Content is never hidden from assistive tech. */
export function Reveal({
  children,
  i = 0,
  as: Tag = 'div',
  className = '',
  ...rest
}: { children: ReactNode; i?: number; as?: ElementType; className?: string } & HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <Tag ref={ref} {...rest} className={`reveal ${visible ? 'is-visible' : ''} ${className}`} style={{ ['--i' as string]: i }}>
      {children}
    </Tag>
  );
}
