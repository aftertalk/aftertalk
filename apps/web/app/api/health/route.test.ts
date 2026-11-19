import { sql } from '@/lib/db/client';

import { GET } from './route';

afterAll(() => sql.end());

test('answers 200 when the database answers', async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('runs against this worker’s own database copy', async () => {
  const [{ name }] = await sql<{ name: string }[]>`select current_database() as name`;
  expect(name).toMatch(/^aftertalk_test_\d+$/);
});
