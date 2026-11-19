'use client';

import { ReactNode, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface ConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  /** Ask a question ("Usunąć webhook?"); the button says the exact action ("Usuń webhook"). */
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  variant?: 'default' | 'destructive';
  isLoading?: boolean;
  loadingText?: string;
  disabled?: boolean;
  /** Type-to-confirm for irreversible actions: the button stays disabled until this exact text is typed. */
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
  children?: ReactNode;
}

// Confirmations interrupt on purpose: focus starts on Cancel, and the dialog can't be dismissed while busy.
export function ConfirmModal({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'default',
  isLoading = false,
  loadingText,
  disabled = false,
  confirmPhrase,
  confirmPhraseLabel,
  children,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const phraseMissing = !!confirmPhrase && typed.trim() !== confirmPhrase;

  const handleOpenChange = (next: boolean) => {
    if (isLoading) return;
    if (!next) setTyped('');
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <DialogHeader className="pr-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {confirmPhrase && (
          <label className="block space-y-2">
            {confirmPhraseLabel && <span className="text-meta text-muted-foreground block">{confirmPhraseLabel}</span>}
            {/* No placeholder: the phrase greyed out in the box read as already typed. The label names it. */}
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isLoading} autoFocus>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={() => onConfirm()} disabled={isLoading || disabled || phraseMissing}>
            {isLoading && loadingText ? loadingText : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
