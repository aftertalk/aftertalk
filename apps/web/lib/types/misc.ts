// Small view types: speaker presets, organisations, projects, the account and the overview page.
import type { DashboardActionItem } from './action-items';
import type { SupportedLanguage } from './language';

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type ProjectRole = 'VIEWER' | 'EDITOR' | 'ADMIN';

export interface SpeakerPreset {
  id: string;
  name: string;
  speakers: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  useCase?: string;
  allowMemberProjectCreate: boolean;
  twoFaRequired: boolean;
  role: OrgRole;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateOrganizationRequest {
  name?: string;
  description?: string;
  logoUrl?: string;
  allowMemberProjectCreate?: boolean;
  twoFaRequired?: boolean;
}

export type MemberPiiAccess = 'strict' | 'full';

export interface ProjectResponse {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  /** `allowedLanguages[0]`. */
  defaultLanguage: SupportedLanguage;
  allowedLanguages: SupportedLanguage[];
  memberPiiAccess: MemberPiiAccess;
  retentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The signed-in user's role in a project; the name is kept from the cloud. */
export interface MyProjectAccessResponse {
  role: ProjectRole;
  orgRole: OrgRole;
}

export interface AccountDto {
  id: string;
  email: string;
  twoFactorEnabled: boolean;
  created: string;
  updated: string;
  displayName?: string;
  timeZone: string;
}

export interface ActionItems {
  items: DashboardActionItem[];
  totalPending: number;
}

export interface CallVolumeEntry {
  date: string;
  count: number;
}

export interface CallVolume {
  data: CallVolumeEntry[];
  granularity: string;
}

export interface DashboardMetrics {
  totalCalls: number;
  totalCallsTrend: number;
  avgDurationSeconds: number;
  avgDurationTrend: number;
  positiveSentimentPercent: number;
  pendingActionItems: number;
}

export interface SentimentDistribution {
  positive: number;
  neutral: number;
  negative: number;
  unknown: number;
  total: number;
}

export interface SentimentTrendEntry {
  date: string;
  positivePercent: number;
  neutralPercent: number;
  negativePercent: number;
}

export interface SentimentOverview {
  distribution: SentimentDistribution;
  trend: SentimentTrendEntry[];
  averageConfidence: number;
}
