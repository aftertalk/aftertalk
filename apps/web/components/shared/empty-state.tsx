import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * One action at most: the next step, not a menu. A whole page with nothing in it uses the primary
   * button; an empty section, filter or widget uses variant="outline". Always a Button, never a bare link.
   */
  action?: React.ReactNode;
  className?: string;
}

// Every "nothing here yet" looks the same: a quiet icon, one sentence, one way forward.
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {Icon && (
        <div className="text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-body text-foreground font-medium">{title}</p>
      {description && <p className="text-meta text-muted-foreground mt-1.5 max-w-sm">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
