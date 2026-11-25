import { PageContainer } from '@/components/shared/page-container';
import { Skeleton } from '@/components/ui/skeleton';
import { Surface } from '@/components/ui/surface';

// Same shape as the call page: back link, header, the four tiles, the player, transcript beside the aside.
export default function CallLoading() {
  return (
    <PageContainer>
      <Skeleton className="h-4 w-24" />
      <div className="space-y-3 pb-2">
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-10 w-80 max-w-full" />
        <Skeleton className="h-5 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Surface key={i} className="space-y-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
          </Surface>
        ))}
      </div>
      <Skeleton className="h-14 w-full rounded-2xl" />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="space-y-5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-4">
              <Skeleton className="h-3 w-14" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
        <Surface className="hidden space-y-3 xl:block">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </Surface>
      </div>
    </PageContainer>
  );
}
