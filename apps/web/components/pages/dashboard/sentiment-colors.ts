// Kept for existing imports; the values live in lib/palette.ts so charts, badges and the hero agree.
import { SENTIMENT } from '@/lib/palette';

export const SENTIMENT_COLORS = {
  positive: SENTIMENT.positive,
  neutral: SENTIMENT.neutral,
  negative: SENTIMENT.negative,
} as const;
