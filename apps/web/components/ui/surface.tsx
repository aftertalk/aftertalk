import * as React from 'react';

import { cn } from '@/lib/utils/cn';

// The app's one card. Dark: a faint lift off the page, no border. Light: white with a hairline ring.
// Replaces the copy-pasted card class strings and shadcn's <Card> in app pages.
const TONES = {
  default: 'bg-white ring-1 ring-black/[0.06] dark:bg-white/[0.035] dark:ring-0',
  muted: 'bg-black/[0.02] dark:bg-white/[0.02]',
  danger: 'bg-red-500/[0.04] ring-1 ring-red-500/15 dark:ring-0',
} as const;

const PADS = { none: '', md: 'p-5', lg: 'p-5 md:p-8' } as const;

interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof TONES;
  pad?: keyof typeof PADS;
  as?: 'div' | 'section' | 'article';
}

export function Surface({ tone = 'default', pad = 'md', as = 'div', className, ...props }: SurfaceProps) {
  // Same props for every tag; typed as div so the HTML attribute handlers line up.
  const Tag = as as 'div';
  return <Tag className={cn('rounded-2xl', TONES[tone], PADS[pad], className)} {...props} />;
}

interface SurfaceHeaderProps {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned link or button. */
  action?: React.ReactNode;
  className?: string;
}

export function SurfaceHeader({ title, eyebrow, description, action, className }: SurfaceHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-muted-foreground mb-1.5 font-mono text-[11px] tracking-[0.18em] uppercase">{eyebrow}</p>
        )}
        <h2 className="text-title text-foreground font-medium">{title}</h2>
        {description && <p className="text-meta text-muted-foreground mt-1">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
