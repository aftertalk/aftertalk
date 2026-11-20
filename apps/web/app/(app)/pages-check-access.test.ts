// Every project page checks access itself (lib/page-access.ts says why a layout check is not enough).
// This keeps phase 2's pages honest: a new page.tsx under [projectId] without the call fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === 'page.tsx' ? [full] : [];
  });
}

test('every page under [projectId] calls requireProjectPage', () => {
  const found = pages(path.join(__dirname, '[projectId]'));
  expect(found.length).toBeGreaterThan(0);
  const missing = found.filter((f) => !readFileSync(f, 'utf8').includes('requireProjectPage('));
  expect(missing).toEqual([]);
});
