export const AnalysisTemplateFieldAnswerType = {
  TEXT: 'TEXT',
  BOOLEAN: 'BOOLEAN',
  CHOICE: 'CHOICE',
  NUMERIC: 'NUMERIC',
} as const;
export type AnalysisTemplateFieldAnswerType =
  (typeof AnalysisTemplateFieldAnswerType)[keyof typeof AnalysisTemplateFieldAnswerType];

export interface AnalysisTemplateField {
  id: string;
  label: string;
  prompt: string;
  answerType: AnalysisTemplateFieldAnswerType;
  options?: string[];
  isRequired: boolean;
  displayOrder: number;
}

export interface AnalysisTemplate {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  fields: AnalysisTemplateField[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateFieldRequest {
  label: string;
  prompt: string;
  answerType: string;
  options?: string[];
  isRequired?: boolean;
}

export interface CreateTemplateRequest {
  name: string;
  description?: string;
  fields: CreateFieldRequest[];
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  fields?: CreateFieldRequest[];
}
