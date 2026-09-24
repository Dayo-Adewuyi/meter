import type { ElementType } from 'react';

/**
 * A display heading whose letters are inscribed one by one. Screen readers get
 * the whole word from aria-label; the animated spans are hidden from them.
 */
export function Inscribe({ text, as: Tag = 'h1', className = '' }: { text: string; as?: ElementType; className?: string }) {
  let i = 0;
  return (
    <Tag className={`display inscribe ${className}`} aria-label={text}>
      {text.split(' ').map((word, w, words) => (
        <span key={w} aria-hidden="true" className="word">
          {Array.from(word).map((letter, l) => (
            <span key={l} className="l" style={{ ['--i' as string]: i++ }}>
              {letter}
            </span>
          ))}
          {w < words.length - 1 ? <span className="l space" style={{ ['--i' as string]: i++ }}>&nbsp;</span> : null}
        </span>
      ))}
    </Tag>
  );
}
