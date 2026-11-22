import { safeNext } from './safe-next';

test.each([
  ['/abc/home', '/abc/home'],
  ['/reset-password?token=x', '/reset-password?token=x'],
  [null, '/'],
  ['', '/'],
  ['https://evil.example', '/'],
  ['//evil.example', '/'],
  ['/\\evil.example', '/'],
  ['/\t/evil.example', '/'],
  ['javascript:alert(1)', '/'],
])('%s → %s', (input, expected) => {
  expect(safeNext(input)).toBe(expected);
});
