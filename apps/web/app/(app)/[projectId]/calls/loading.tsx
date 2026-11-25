import { PageContainer } from '@/components/shared/page-container';
import { Skeleton } from '@/components/ui/skeleton';
import { Surface } from '@/components/ui/surface';

// Same shape as the list it stands in for: header, search, and a column of rows.
export default function CallsLoading() {
  return (
    <PageContainer>
      <div className="space-y-3 pb-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-11 w-full max-w-lg rounded-xl" />
        <Surface pad="none" className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="flex items-center gap-6 px-5 py-4 md:grid md:grid-cols-[minmax(0,1fr)_7rem_5rem_8.5rem]"
            >
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="hidden h-5 w-20 rounded-full md:block" />
              <Skeleton className="hidden h-3 w-10 md:block" />
              <Skeleton className="ml-auto hidden h-3 w-24 md:block" />
            </div>
          ))}
        </Surface>
      </div>
    </PageContainer>
  );
}
