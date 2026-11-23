'use client';

import { Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

// A secret (API key, webhook signing secret) shown exactly once, inline on the row it belongs to. Unlike the
// old dialogs it can't be lost to Esc or an outside click: it stays until "copied" is confirmed, focuses Copy,
// and warns before the page unloads.
interface RevealSecretProps {
  secret: string;
  title: string;
  description: string;
  copyLabel: string;
  copiedLabel: string;
  doneLabel: string;
  onDone: () => void;
}

export function RevealSecret({
  secret,
  title,
  description,
  copyLabel,
  copiedLabel,
  doneLabel,
  onDone,
}: RevealSecretProps) {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    copyRef.current?.focus();
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // Clipboard refused; the value is selectable on screen.
    }
  };

  return (
    <div className="animate-in fade-in-0 space-y-4 bg-black/[0.02] px-5 py-5 duration-150 md:px-6 dark:bg-white/[0.03]">
      <div className="flex items-start gap-3">
        <KeyRound className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-body text-foreground font-medium">{title}</p>
          <p className="text-meta text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="bg-background text-meta min-w-0 flex-1 rounded-lg px-3 py-2.5 font-mono break-all select-all">
          {secret}
        </code>
        <Button ref={copyRef} variant="outline" onClick={copy} className="shrink-0">
          {copied ? <Check className="text-foreground" /> : <Copy />}
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      <div className="flex justify-end">
        {/* Never disabled: if the clipboard is refused the user copies by hand and still needs a way out. */}
        <Button onClick={onDone} variant={copied ? 'default' : 'outline'}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
