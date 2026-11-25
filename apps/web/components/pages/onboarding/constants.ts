import { i18n } from '@/i18n/constants';
import { AnalysisTemplateFieldAnswerType } from '@/lib/types';

// ─── Suggested categories ──────────────────────────────────────────────────────

// Picking a suggestion writes it straight into the project, so these are translated at the moment
// someone clicks and the resulting category belongs to them in their own language.
export interface SuggestedCategory {
  nameKey: string;
  descriptionKey: string;
}

const C = i18n.suggestions.categories;

export const SUGGESTED_CATEGORIES: SuggestedCategory[] = [
  { nameKey: C.customerSupport.name, descriptionKey: C.customerSupport.description },
  { nameKey: C.sales.name, descriptionKey: C.sales.description },
  { nameKey: C.hr.name, descriptionKey: C.hr.description },
  { nameKey: C.onboarding.name, descriptionKey: C.onboarding.description },
  { nameKey: C.technicalSupport.name, descriptionKey: C.technicalSupport.description },
  { nameKey: C.billing.name, descriptionKey: C.billing.description },
  { nameKey: C.complaints.name, descriptionKey: C.complaints.description },
  { nameKey: C.productDemo.name, descriptionKey: C.productDemo.description },
  { nameKey: C.followUp.name, descriptionKey: C.followUp.description },
];

// ─── Suggested roles ───────────────────────────────────────────────────────────

export interface SuggestedRole {
  nameKey: string;
  speakerKeys: string[];
}

const R = i18n.suggestions.roles;

export const SUGGESTED_ROLES: SuggestedRole[] = [
  { nameKey: R.salesCall.name, speakerKeys: R.salesCall.speakers },
  { nameKey: R.supportCall.name, speakerKeys: R.supportCall.speakers },
  { nameKey: R.discoveryCall.name, speakerKeys: R.discoveryCall.speakers },
  { nameKey: R.jobInterview.name, speakerKeys: R.jobInterview.speakers },
  { nameKey: R.teamMeeting.name, speakerKeys: R.teamMeeting.speakers },
  { nameKey: R.onboarding.name, speakerKeys: R.onboarding.speakers },
  { nameKey: R.productDemo.name, speakerKeys: R.productDemo.speakers },
];

// ─── Example templates ─────────────────────────────────────────────────────────

export interface ExampleField {
  labelKey: string;
  answerType: AnalysisTemplateFieldAnswerType;
  promptKey: string;
  optionKeys?: string[];
}

export interface ExampleTemplate {
  id: string;
  nameKey: string;
  fields: ExampleField[];
}

const T = i18n.exampleTemplates;

// Same as the category and role suggestions: picking one writes a template into the project, so the
// wording — including the question put to the analyzer — is resolved in the reader's language at
// that moment. Calls here are transcribed in Polish, so a Polish question is the one that fits them.
export const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
  {
    id: 'sales-discovery',
    nameKey: T.salesDiscovery.name,
    fields: [
      {
        labelKey: T.salesDiscovery.fields.callOutcome.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.salesDiscovery.fields.callOutcome.prompt,
      },
      {
        labelKey: T.salesDiscovery.fields.painPoints.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.salesDiscovery.fields.painPoints.prompt,
      },
      {
        labelKey: T.salesDiscovery.fields.budgetDiscussed.label,
        answerType: AnalysisTemplateFieldAnswerType.BOOLEAN,
        promptKey: T.salesDiscovery.fields.budgetDiscussed.prompt,
      },
      {
        labelKey: T.salesDiscovery.fields.nextSteps.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.salesDiscovery.fields.nextSteps.prompt,
      },
    ],
  },
  {
    id: 'customer-support',
    nameKey: T.customerSupport.name,
    fields: [
      {
        labelKey: T.customerSupport.fields.issueResolved.label,
        answerType: AnalysisTemplateFieldAnswerType.BOOLEAN,
        promptKey: T.customerSupport.fields.issueResolved.prompt,
      },
      {
        labelKey: T.customerSupport.fields.customerSentiment.label,
        answerType: AnalysisTemplateFieldAnswerType.CHOICE,
        promptKey: T.customerSupport.fields.customerSentiment.prompt,
        optionKeys: T.customerSupport.options,
      },
      {
        labelKey: T.customerSupport.fields.summary.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.customerSupport.fields.summary.prompt,
      },
    ],
  },
  {
    id: 'job-interview',
    nameKey: T.jobInterview.name,
    fields: [
      {
        labelKey: T.jobInterview.fields.candidateFit.label,
        answerType: AnalysisTemplateFieldAnswerType.CHOICE,
        promptKey: T.jobInterview.fields.candidateFit.prompt,
        optionKeys: T.jobInterview.options,
      },
      {
        labelKey: T.jobInterview.fields.keyStrengths.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.jobInterview.fields.keyStrengths.prompt,
      },
      {
        labelKey: T.jobInterview.fields.redFlags.label,
        answerType: AnalysisTemplateFieldAnswerType.TEXT,
        promptKey: T.jobInterview.fields.redFlags.prompt,
      },
    ],
  },
];

// ─── Answer type display labels ────────────────────────────────────────────────

export const ANSWER_TYPE_LABELS: Record<AnalysisTemplateFieldAnswerType, string> = {
  [AnalysisTemplateFieldAnswerType.TEXT]: 'Text',
  [AnalysisTemplateFieldAnswerType.BOOLEAN]: 'Yes / No',
  [AnalysisTemplateFieldAnswerType.CHOICE]: 'Multiple choice',
  [AnalysisTemplateFieldAnswerType.NUMERIC]: 'Number',
};
