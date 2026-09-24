'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/** A native <dialog>: focus trap, Escape and backdrop come from the platform. */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    // A modal lives in the top layer, above any custom cursor: hand back the system one.
    document.documentElement.classList.toggle('dialog-open', open);
    return () => document.documentElement.classList.remove('dialog-open');
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="confirm-title" onClose={onCancel} onClick={(event) => event.target === ref.current && onCancel()}>
      <div className="dialog__body">
        <p className="eyebrow" style={{ color: 'var(--blood-hi)' }}>
          This cannot be undone
        </p>
        <h2 id="confirm-title" className="display display--section" style={{ marginTop: 12 }}>
          {title}
        </h2>
        <div style={{ marginTop: 16 }}>{children}</div>
        <div className="dialog__actions">
          <button type="button" className="btn btn--quiet" onClick={onCancel} disabled={busy}>
            Stay my hand
          </button>
          <button type="button" className="btn btn--blood" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
