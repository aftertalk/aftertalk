'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils/cn';

// The one inline-form pattern (instead of a modal for small forms): the form opens in place, inside the
// Surface it belongs to, on a soft fill. First field gets focus; Esc cancels and the caller returns focus
// to its trigger; Enter submits through the <form>. Success/errors are shown by the caller in place, not
// as toasts. Keep one editor open per page and hide its trigger while open.
interface InlineEditorProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
  className?: string;
  /** Label for screen readers, e.g. "Zaproś osoby". */
  label: string;
}

export function InlineEditor({ open, onCancel, onSubmit, children, className, label }: InlineEditorProps) {
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, [role=combobox]')?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <form
      ref={ref}
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onCancel();
        }
      }}
      className={cn(
        'animate-in fade-in-0 slide-in-from-top-1 space-y-4 bg-black/[0.02] px-5 py-5 duration-150 md:px-6 dark:bg-white/[0.03]',
        className
      )}
    >
      {children}
    </form>
  );
}

/**
 * Right-aligned "Anuluj" + primary action row used at the bottom of every InlineEditor. The primary
 * button stays enabled until it is pressed and is disabled only while saving; a missing or invalid
 * value is reported here as `error` on submit, so a greyed-out button never leaves the reader guessing.
 */
export function InlineEditorActions({ error, children }: { error?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
      {error && <p className="text-meta text-negative mr-auto">{error}</p>}
      <div className="flex justify-end gap-2">{children}</div>
    </div>
  );
}
