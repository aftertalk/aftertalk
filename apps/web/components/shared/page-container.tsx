import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

interface PageContainerProps {
  /** Override the default vertical rhythm / padding when a page needs to differ. */
  className?: string;
  children: ReactNode;
}

// The single wrapper for every authed app page's content. Owns the horizontal inset, the bottom
// padding and the vertical rhythm between sections. Every page uses the full width with the same
// gutters, so nothing jumps when switching pages and wide screens aren't left half empty.
export function PageContainer({ className, children }: PageContainerProps) {
  return (
    <div className={cn('animate-page-enter space-y-8 px-4 pt-2 pb-12 md:px-5 md:pb-16', className)}>{children}</div>
  );
}
