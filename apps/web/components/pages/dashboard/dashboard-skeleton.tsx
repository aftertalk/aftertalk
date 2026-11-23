import { Surface } from '@/components/ui/surface';
import { cn } from '@/lib/utils/cn';

const BLOCK = 'animate-pulse rounded-md bg-foreground/[0.06]';

/** Page title placeholder: mono eyebrow, big title, and the date picker on the right. */
export function PageHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className={cn(BLOCK, 'mb-3 h-3 w-48')} />
        <div className={cn(BLOCK, 'h-9 w-56 md:h-11 md:w-72')} />
      </div>
      <div className={cn(BLOCK, 'h-9 w-40')} />
    </div>
  );
}

function CardSkeleton({ className, kpi = false }: { className?: string; kpi?: boolean }) {
  return (
    <Surface className={cn('flex flex-col', className)}>
      <div className={cn(BLOCK, kpi ? 'h-4 w-28' : 'h-5 w-40')} />
      {kpi ? (
        <>
          <div className={cn(BLOCK, 'mt-3 h-8 w-20')} />
          <div className={cn(BLOCK, 'mt-auto h-6 w-full opacity-60')} />
        </>
      ) : (
        <div className={cn(BLOCK, 'mt-5 flex-1 opacity-60')} />
      )}
    </Surface>
  );
}

/**
 * Stand-in for a dashboard while it loads, shaped like the usual one: a row of four stats, then two
 * rows of paired cards. Matches the grid's 16px gaps so nothing shifts when the widgets arrive.
 */
export function DashboardGridSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <CardSkeleton key={i} kpi className="h-40" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <CardSkeleton className="h-[336px] lg:col-span-7" />
        <CardSkeleton className="h-[336px] lg:col-span-5" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CardSkeleton className="h-[424px]" />
        <CardSkeleton className="h-[424px]" />
      </div>
    </div>
  );
}
