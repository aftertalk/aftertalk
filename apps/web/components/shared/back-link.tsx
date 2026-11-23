import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils/cn';

const CLASS =
  'text-meta text-muted-foreground hover:text-foreground -ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 font-medium transition-colors';

type BackLinkProps = { children: React.ReactNode; className?: string } & (
  { href: string; onClick?: never } | { onClick: () => void; href?: never }
);

/** The one "back to …" control: an arrow and the place it returns to, above the page or panel it leaves. */
export function BackLink({ href, onClick, children, className }: BackLinkProps) {
  const content = (
    <>
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </>
  );
  return href ? (
    <Link href={href} className={cn(CLASS, className)}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cn(CLASS, className)}>
      {content}
    </button>
  );
}
