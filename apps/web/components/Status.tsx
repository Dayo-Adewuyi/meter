import { StatusGlyph } from './icons';

const WORDS: Record<string, string> = {
  active: 'In force',
  revoked: 'Dissolved',
  delivered: 'Delivered',
  processing: 'In passage',
  failed: 'Refused',
  declined: 'Denied',
  expired: 'Lapsed',
};

/** Status as word + glyph + colour, never colour alone. */
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status--${status}`}>
      <StatusGlyph status={status} />
      {WORDS[status] ?? status}
    </span>
  );
}
