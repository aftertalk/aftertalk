import { negotiateLocale } from './config';

test('picks the best supported language from Accept-Language', () => {
  expect(negotiateLocale('pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('pl');
  expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
  expect(negotiateLocale('de-DE,de;q=0.9,pl;q=0.8,en;q=0.5')).toBe('pl');
  expect(negotiateLocale('en;q=0.4, PL;q=0.6')).toBe('pl');
  expect(negotiateLocale('fr, en')).toBe('en');
});

test('no usable language gives null, so the default applies', () => {
  expect(negotiateLocale(null)).toBeNull();
  expect(negotiateLocale('')).toBeNull();
  expect(negotiateLocale('fr-FR,de;q=0.8')).toBeNull();
  expect(negotiateLocale('pl;q=0, *')).toBeNull();
});
