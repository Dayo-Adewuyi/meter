import type { SVGProps } from 'react';

/** One hand-drawn set: 24px grid, 1.5 stroke, square joins. Decorative unless labelled. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

/** Quatrefoil: four circles about a centre — the wordmark and ornament glyph. */
export const Quatrefoil = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="7" r="4.2" />
    <circle cx="17" cy="12" r="4.2" />
    <circle cx="12" cy="17" r="4.2" />
    <circle cx="7" cy="12" r="4.2" />
    <path d="M12 9.5v5M9.5 12h5" />
  </Icon>
);

export const Seal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.5l2.1 1.6 2.6-.3 1 2.4 2.4 1-.3 2.6L21.5 12l-1.6 2.1.3 2.6-2.4 1-1 2.4-2.6-.3L12 21.5l-2.1-1.6-2.6.3-1-2.4-2.4-1 .3-2.6L2.5 12l1.6-2.1-.3-2.6 2.4-1 1-2.4 2.6.3z" fill="currentColor" fillOpacity="0.2" />
    <path d="M9 9.5l3 5 3-5" />
  </Icon>
);

export const Scroll = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 4h11v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-1h11v1a3 3 0 0 0 3 3" />
    <path d="M7 4a2 2 0 0 0-2 2v10M10 8h5M10 11h5" />
  </Icon>
);

export const Coin = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="5.5" />
    <path d="M10 9.5v5M14 9.5v5M10 9.5l4 5" />
  </Icon>
);

export const Bell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5h4M12 3v2" />
  </Icon>
);

export const Chevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const ArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Icon>
);

export const Cross = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v16M4 12h16" />
  </Icon>
);

export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="8" width="12" height="12" />
    <path d="M16 8V4H4v12h4" />
  </Icon>
);

export const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5M12 17.5v.5" />
  </Icon>
);

export const Flame = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3c3 4 5 6 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z" />
  </Icon>
);

/** Status glyphs carry meaning with shape as well as colour. */
export const StatusGlyph = ({ status, size = 14 }: { status: string; size?: number }) => {
  switch (status) {
    case 'active':
    case 'delivered':
    case 'settled':
      return <Check size={size} />;
    case 'processing':
    case 'pending':
      return <Quatrefoil size={size} />;
    case 'expired':
    case 'lapsed':
      return <Flame size={size} />;
    default:
      return <Cross size={size} />;
  }
};
