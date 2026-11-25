// The languages a call can be processed in (#15). A project allows a subset; its first language is its default.
export const SupportedLanguage = {
  pl: 'pl',
  en: 'en',
  uk: 'uk',
  de: 'de',
} as const;

export type SupportedLanguage = (typeof SupportedLanguage)[keyof typeof SupportedLanguage];

/** The name is kept from the cloud, where it typed the language field of the upload form. */
export const UploadAudioLanguage = SupportedLanguage;
export type UploadAudioLanguage = SupportedLanguage;
