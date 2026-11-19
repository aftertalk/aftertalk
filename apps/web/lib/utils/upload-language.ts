import { i18n } from '@/i18n/constants';
import { SupportedLanguage } from '@/lib/types/language';

// Which language the transcriber should assume for an upload. An upload that names no language is
// processed in the project's default, so "not chosen" is a real state here rather than a synonym for
// Polish — sending a language the uploader never picked would override that project setting.
export const UPLOAD_LANGUAGES = Object.values(SupportedLanguage);

export type UploadLanguage = SupportedLanguage;

// Not the common.languages.* keys: those name the interface language and read "Polish (Polski)" in
// English, which nests a second bracket inside "Project default (…)". The audio's language and the
// reader's language are separate choices and get separate wording.
export const LANGUAGE_KEYS: Record<UploadLanguage, string> = {
  pl: i18n.common.transcriptionLanguages.pl,
  en: i18n.common.transcriptionLanguages.en,
  uk: i18n.common.transcriptionLanguages.uk,
  de: i18n.common.transcriptionLanguages.de,
};
