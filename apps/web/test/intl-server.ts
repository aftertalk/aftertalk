// next-intl/server for tests without a request: English messages, `{name}` placeholders filled.
// Use with: jest.mock('next-intl/server', () => jest.requireActual('@/test/intl-server')).
import en from '@/messages/en.json';

const lookup = (key: string, values?: Record<string, unknown>) => {
  const text = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
  if (typeof text !== 'string') return key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
};

export const getTranslations = async () => lookup;
export const getLocale = async () => 'en';
export const getFormatter = async () => ({
  dateTime: (d: Date) => d.toISOString(),
});
