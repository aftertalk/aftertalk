// The languages a call can be processed in (#15). A project allows a subset; Polish is the default.
export const SupportedLanguage = {
  pl: 'pl',
  en: 'en',
  uk: 'uk',
  de: 'de',
} as const;

export type SupportedLanguage = (typeof SupportedLanguage)[keyof typeof SupportedLanguage];
