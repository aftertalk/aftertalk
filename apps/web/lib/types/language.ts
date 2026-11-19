// The languages a call can be processed in (#15). A project allows a subset; its first language is its default.
export const SupportedLanguage = {
  pl: 'pl',
  en: 'en',
  uk: 'uk',
  de: 'de',
} as const;

export type SupportedLanguage = (typeof SupportedLanguage)[keyof typeof SupportedLanguage];
