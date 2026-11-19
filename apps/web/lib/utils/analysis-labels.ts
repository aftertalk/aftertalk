import { i18n } from '@/i18n/constants';

// The analyzer hands back bare enum values ("very_negative", "CUSTOMER", "MEDIUM"). They are English
// and shaped for a machine, so nothing from the backend is safe to put on screen as-is. Anything we
// don't have a translation for still gets tidied up rather than shown as a raw token.

type Translate = (key: string) => string;

const SENTIMENT_KEYS: Record<string, string> = {
  very_positive: i18n.dashboard.sentimentDistribution.veryPositive,
  positive: i18n.dashboard.sentimentDistribution.positive,
  neutral: i18n.dashboard.sentimentDistribution.neutral,
  negative: i18n.dashboard.sentimentDistribution.negative,
  very_negative: i18n.dashboard.sentimentDistribution.veryNegative,
};

// Who is speaking, and who a task falls to, come from the same small vocabulary.
const PARTY_KEYS: Record<string, string> = {
  agent: i18n.dashboard.parties.agent,
  customer: i18n.dashboard.parties.customer,
  company: i18n.dashboard.parties.company,
};

const CONFIDENCE_KEYS: Record<string, string> = {
  low: i18n.dashboard.transcriptModal.analysis.confidenceLow,
  medium: i18n.dashboard.transcriptModal.analysis.confidenceMedium,
  high: i18n.dashboard.transcriptModal.analysis.confidenceHigh,
};

function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function translate(keys: Record<string, string>, value: string | null | undefined, t: Translate): string {
  if (!value) return '';
  const key = keys[value.toLowerCase()];
  return key ? t(key) : humanize(value);
}

export function sentimentLabel(value: string | null | undefined, t: Translate): string {
  return translate(SENTIMENT_KEYS, value, t);
}

export function confidenceLabel(value: string | null | undefined, t: Translate): string {
  return translate(CONFIDENCE_KEYS, value, t);
}

// When a call is uploaded with channel roles, the transcriber uses the chosen role name as the
// speaker id, so "Konsultant" arrives already saying what the project calls that seat and is left
// alone. Only the two names it falls back to when no roles were given need translating.
export function speakerLabel(speakerId: string, name: string | null | undefined, t: Translate): string {
  return name || translate(PARTY_KEYS, speakerId, t);
}

export function partyLabel(value: string | null | undefined, t: Translate): string {
  return translate(PARTY_KEYS, value, t);
}

const CATALOG_KEYS: Record<string, string> = {
  CALL_COUNT: i18n.analytics.measures.CALL_COUNT,
  AVG_DURATION: i18n.analytics.measures.AVG_DURATION,
  TOTAL_DURATION: i18n.analytics.measures.TOTAL_DURATION,
  POSITIVE_SENTIMENT_PCT: i18n.analytics.measures.POSITIVE_SENTIMENT_PCT,
  AVG_SENTIMENT_CONFIDENCE: i18n.analytics.measures.AVG_SENTIMENT_CONFIDENCE,
  ACTION_ITEMS_TOTAL: i18n.analytics.measures.ACTION_ITEMS_TOTAL,
  FOLLOWUP_REQUIRED_PCT: i18n.analytics.measures.FOLLOWUP_REQUIRED_PCT,
  DATE: i18n.analytics.dimensions.DATE,
  CATEGORY: i18n.analytics.dimensions.CATEGORY,
  SENTIMENT_LEVEL: i18n.analytics.dimensions.SENTIMENT_LEVEL,
  LANGUAGE: i18n.analytics.dimensions.LANGUAGE,
};

// The builder's measure and group-by lists come from the API already worded in English. The built-in
// ones have a stable key we can say ourselves; a custom template field is titled by whoever created
// it, so its own label is already the right words and is kept.
export function catalogLabel(key: string, fallback: string, t: Translate): string {
  return CATALOG_KEYS[key] ? t(CATALOG_KEYS[key]) : fallback;
}

// Analytics groups calls by whatever dimension the widget asked for, so a chart axis or legend can
// carry a sentiment level one moment and a category name the next. Only the values we recognise get
// swapped; a real category name is already the user's own words and is left alone.
export function dimensionLabel(value: string, t: Translate): string {
  const normalized = value.toLowerCase();
  if (normalized === 'uncategorized') return t(i18n.calls.table.noCategory);
  return SENTIMENT_KEYS[normalized] ? t(SENTIMENT_KEYS[normalized]) : value;
}
