// View types for calls (item 29a). Server actions build these from database rows; components never
// import lib/db/schema. Text in them is always redacted (item 36).
import type { ActionItem } from './action-items';

/** What the UI shows; computed from `calls.status` and the latest job (Status model). */
export type CallStatus = 'queued' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

/** A run started after the stored result: queued, processing, or failed with its reason. */
export interface LaterRun {
  status: 'queued' | 'processing' | 'failed';
  errorCode: string | null;
}

export interface Call {
  id: string;
  filename: string;
  /** Empty until a result is stored. */
  language: string;
  sizeBytes: number;
  durationS: number;
  sentimentLevel?: string;
  primaryCategory?: string;
  actionItemsCount: number;
  createdAt: string;
  title?: string;
  status: CallStatus;
  /** The error code of the failed job, when `status` is `failed`. */
  failedReason: string | null;
  /** For `language_not_allowed`: the language the engine detected, when it reported one. */
  detectedLanguage: string | null;
  laterRun: LaterRun | null;
}

export interface CallSearchResult extends Call {
  snippet: string;
  relevance: number;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export type PagedResultCall = PagedResult<Call>;
export type PagedResultCallSearchResult = PagedResult<CallSearchResult>;

export interface Turn {
  /** 1-based, the number shown to the model. */
  index: number;
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
  /** 0-based, inclusive. */
  startWord: number;
  endWord: number;
}

export interface Speaker {
  speakerId: string;
  name?: string;
  talkRatio?: number;
  turnCount?: number;
  wordCount?: number;
  totalDurationS?: number;
}

export type QuoteMatch = 'verbatim' | 'normalised' | 'other_turn' | 'unverified';

/** A word range of the transcript that backs a claim. `text` is the redacted words of the range. */
export interface Quote {
  turn: number;
  startWord: number | null;
  endWord: number | null;
  startMs: number | null;
  match: QuoteMatch;
  /** null for `unverified`. */
  text: string | null;
}

export interface Step {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  errorCode: string | null;
  cached: boolean;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export const SentimentAnalysisOverallSentiment = {
  very_negative: 'very_negative',
  negative: 'negative',
  neutral: 'neutral',
  positive: 'positive',
  very_positive: 'very_positive',
} as const;
export type SentimentAnalysisOverallSentiment =
  (typeof SentimentAnalysisOverallSentiment)[keyof typeof SentimentAnalysisOverallSentiment];

export interface SentimentAnalysis {
  overallSentiment: SentimentAnalysisOverallSentiment;
  sentimentProgression?: string;
  confidence: number;
  evidence: Quote[];
}

export interface CallSummary {
  executiveSummary: string;
  keyDiscussionPoints: string[];
  resolutionProvided?: string;
  followUpRequired: boolean;
  nextSteps: string[];
}

export interface CallAnalysis {
  summary: CallSummary;
  sentiment?: SentimentAnalysis;
  sentimentLevel?: string;
  actionItems: ActionItem[];
  modelUsed: string;
}

export interface CategoryClassification {
  categoryId: string;
  categoryPath: string[];
  categoryNames: string[];
  confidence: number;
  /** The model's own words, shown as such; not a quote. */
  explanation: string | null;
  depth: number;
}

export interface Classification {
  primary: CategoryClassification;
  secondary: CategoryClassification[];
  overallConfidence: number;
  reasoning: string;
  modelUsed: string;
}

export interface PiiStatistics {
  totalDetected: number;
  types: Record<string, number>;
}

export interface TemplateFieldResult {
  label: string;
  value?: unknown;
  answerType: string;
  confidence: string;
  evidence: Quote[];
  answered: boolean;
}

export interface TemplateAnalysisDetail {
  templateName: string;
  results: TemplateFieldResult[];
  modelUsed: string;
  analyzedAt: string;
}

/** An analysis with no result to show: the reason for the empty section of the call page. */
export interface AnalysisFailure {
  kind: 'summary' | 'call_reason' | 'scorecard';
  errorCode: string | null;
}

export interface CallDetail extends Call {
  updatedAt: string;
  /** The redacted turns joined. */
  fullText: string;
  speakers: Speaker[];
  turns: Turn[];
  piiStatistics?: PiiStatistics;
  classification?: Classification;
  /** Set by hand; shown in place of the model's primary reason. */
  manualCategoryId: string | null;
  summary?: CallAnalysis;
  templateAnalysis?: TemplateAnalysisDetail;
  failedAnalyses: AnalysisFailure[];
  steps: Step[];
  channelRoles: { channel_0: string; channel_1: string } | null;
  canShowOriginal: boolean;
  canPlayAudio: boolean;
  /** May delete the call (project admin). */
  canDelete: boolean;
  /** May see who opened the original text or audio (organisation admin). */
  canSeeAccessLog: boolean;
  /** False when the file had one channel and the project had no diarization provider. */
  diarized: boolean;
}

export interface PiiAccessLogEntry {
  userName: string | null;
  kind: 'text' | 'audio';
  createdAt: string;
}
