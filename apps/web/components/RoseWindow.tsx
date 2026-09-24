/**
 * A limit gauge drawn as a gothic rose window: each lit petal is 1/PETALS of
 * the limit used. The value and label are text, so nothing rests on colour.
 */
const PETALS = 16;

function petal(index: number): string {
  // A lancet petal from r=50 to r=92, pointed at the rim.
  const angle = (index / PETALS) * Math.PI * 2 - Math.PI / 2;
  const spread = (Math.PI / PETALS) * 0.78;
  const point = (r: number, a: number) => `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  return `M ${point(50, angle - spread * 0.5)} Q ${point(76, angle - spread * 1.05)} ${point(92, angle)} Q ${point(76, angle + spread * 1.05)} ${point(50, angle + spread * 0.5)} Z`;
}

const PATHS = Array.from({ length: PETALS }, (_, i) => petal(i));

export function RoseWindow({
  used,
  value,
  label,
  description,
  size = 200,
}: {
  /** Share of the limit already used, 0..1. */
  used: number;
  value: string;
  label: string;
  /** Full sentence for screen readers. */
  description: string;
  size?: number;
}) {
  const lit = Math.min(PETALS, Math.round(used * PETALS));
  const tone = used >= 1 ? 'rose--spent' : used >= 0.75 ? 'rose--warn' : '';
  return (
    <div className={`rose ${tone}`} style={{ ['--size' as string]: `${size}px` }} role="img" aria-label={description}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle className="rose__ring rose__ring--gilt" cx="100" cy="100" r="98" />
        <circle className="rose__ring" cx="100" cy="100" r="94" strokeDasharray="1 5.2" />
        {PATHS.map((d, i) => (
          <path key={i} d={d} className={`rose__petal ${i < lit ? 'is-lit' : ''}`} style={{ ['--p' as string]: i }} />
        ))}
        {/* Tracery: cusps between the petals, and a dark oculus for the figures. */}
        {Array.from({ length: PETALS }, (_, i) => {
          const a = ((i + 0.5) / PETALS) * Math.PI * 2 - Math.PI / 2;
          return <circle key={i} className="rose__tracery" cx={100 + 88 * Math.cos(a)} cy={100 + 88 * Math.sin(a)} r="3" />;
        })}
        <circle className="rose__oculus" cx="100" cy="100" r="47" />
        <circle className="rose__ring rose__ring--gilt" cx="100" cy="100" r="47" />
        <circle className="rose__ring" cx="100" cy="100" r="43" strokeDasharray="2 3" />
      </svg>
      <div className="rose__core">
        <span>
          <span className="rose__value figure">{value}</span>
          <span className="rose__label">{label}</span>
        </span>
      </div>
    </div>
  );
}
