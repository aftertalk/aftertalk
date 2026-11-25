import { DashboardGridSkeleton, PageHeaderSkeleton } from '@/components/pages/dashboard/dashboard-skeleton';
import { PageContainer } from '@/components/shared/page-container';

// The home page waits on several dashboard queries; a skeleton in its own shape beats a spinner.
export default function Loading() {
  return (
    <PageContainer>
      <PageHeaderSkeleton />
      <DashboardGridSkeleton />
    </PageContainer>
  );
}
