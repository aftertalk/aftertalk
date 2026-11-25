import type {
  ActionItems,
  CallVolume,
  CallVolumeEntry,
  DashboardActionItem,
  DashboardMetrics,
  SentimentDistribution,
  SentimentOverview,
  SentimentTrendEntry,
} from '@/lib/types';
import type { DateRange, DateRangeInput, DateRangePreset } from '@/lib/utils/date-range';

// Names kept from the cloud, so the copied components import what they always did.
export type { DashboardActionItem };
export type DashboardActionItemsResult = ActionItems;
export type TimeGranularity = 'daily' | 'weekly';
export type CallVolumeDataPoint = CallVolumeEntry;
export type CallVolumeResult = CallVolume;
export type { DashboardMetrics };
export type { DateRange, DateRangeInput, DateRangePreset };
export type SentimentCategory = 'positive' | 'neutral' | 'negative';
export type { SentimentDistribution };
export type SentimentTrendPoint = SentimentTrendEntry;
export type DashboardSentimentResult = SentimentOverview;

export { getDashboardActionItems } from './action-items';
export { getDashboardCallVolume } from './call-volume';
export { getDashboardMetrics } from './metrics';
export { getDashboardSentiment } from './sentiment';
