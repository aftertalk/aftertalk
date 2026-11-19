// Item 29: first-run setup.
import { eq } from 'drizzle-orm';

import { getSessionUser } from '@/lib/access';
import { ensureSetupToken } from '@/lib/auth/setup-token';
import { db, sql } from '@/lib/db/client';
import { analysisTemplates, categories, organizationMembers, projects, speakerPresets } from '@/lib/db/schema/app';
import en from '@/messages/en.json';
import { PASSWORD, resetDb } from '@/test/fixtures';

import { completeSetup, setupStatus } from './setup';

jest.mock('next-intl/server', () => jest.requireActual('@/test/intl-server'));

afterAll(() => sql.end());
beforeEach(resetDb);

test('wrong token is refused; the right one creates owner, organisation, project and starters', async () => {
  expect(await setupStatus()).toEqual({ open: true });
  const token = (await ensureSetupToken())!;
  const input = { name: 'Ada Owner', email: 'Ada@Example.com', password: PASSWORD };

  const wrong = await completeSetup({ ...input, token: 'nope' });
  expect(wrong).toEqual({ ok: false, error: en.setup.invalidToken });

  const ok = await completeSetup({ ...input, token });
  expect(ok.ok).toBe(true);
  const projectId = (ok as { ok: true; data: { projectId: string } }).data.projectId;

  const me = await getSessionUser();
  expect(me?.email).toBe('ada@example.com');
  const [membership] = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, me!.id));
  expect(membership.role).toBe('OWNER');
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  expect(project).toMatchObject({ name: 'First project', visibility: 'ORG', allowedLanguages: ['en'] });
  expect(await db.select().from(speakerPresets).where(eq(speakerPresets.projectId, projectId))).toHaveLength(1);
  const [template] = await db.select().from(analysisTemplates).where(eq(analysisTemplates.projectId, projectId));
  expect(template).toMatchObject({ name: 'General QA', isActive: true });
  expect(await db.select().from(categories)).toHaveLength(5);

  // Afterwards setup is closed for good.
  expect(await setupStatus()).toEqual({ open: false });
  expect(await completeSetup({ ...input, email: 'second@example.com', token })).toEqual({
    ok: false,
    error: 'Not found',
  });
});
