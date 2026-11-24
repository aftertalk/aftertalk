// Cases the phase 2 reviews turned up: day lines in the reader's time zone, an install that must
// not lock its owner out, a provider key that must not follow a connection to another host, the
// upload gate and its active template, presets, and a result that replaces an earlier one.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { db, sql } from '@/lib/db/client';
import { actionItems, analyses, calls, jobs, piiRanges, projects, speakerPresets } from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';
import { type ResultBody, storeResult } from '@/lib/jobs/store-result';
import { landingFor } from '@/lib/landing';
import { cleanBaseUrl } from '@/lib/providers';
import { daysIn, resolveDateRangeInZone, zonedDay, zonedDayStart } from '@/lib/utils/zoned-range';
import { seed } from '@/scripts/seed';
import { addMember, makeOrg, makeUser, resetDb, signIn } from '@/test/fixtures';

import { listActionItems } from './action-items';
import { createAnalysisTemplate, deleteAnalysisTemplate, getAnalysisTemplates } from './analysis-templates';
import { getDashboardCallVolume } from './dashboard';
import { deleteOrganization } from './organizations';
import { getProjectProviders, getProjectReadiness, setProjectProvider } from './project-providers';
import { deleteProject } from './projects';
import { createProviderConnection, updateProviderConnection } from './providers';
import {
  createSpeakerPreset,
  deleteSpeakerPreset,
  getSpeakerPresets,
  setDefaultSpeakerPreset,
  updateSpeakerPreset,
} from './speaker-presets';
import { getCallById, getCallsFiltered } from './transcription';

jest.mock('next-intl/server', () => jest.requireActual('@/test/intl-server'));

afterAll(async () => {
  await sql.end({ timeout: 2 });
});

describe('date ranges on the reader day lines', () => {
  // 23:30 on 10 March in Warsaw is still 10 March there, and already 22:30 UTC.
  const now = new Date('2026-03-10T22:30:00Z');

  test('"last 7 days" is seven whole local days, ending with today', () => {
    const range = resolveDateRangeInZone({ preset: 'last7days' }, 'Europe/Warsaw', now);
    expect(range.from.toISOString()).toBe('2026-03-03T23:00:00.000Z'); // 4 March 00:00 in Warsaw
    expect(range.to.toISOString()).toBe('2026-03-10T22:59:59.999Z'); // 10 March 23:59 in Warsaw
    expect(daysIn(range)).toBe(7);
    // Half an hour later it is 11 March in Warsaw, and the range moves on by a day.
    const later = resolveDateRangeInZone({ preset: 'last7days' }, 'Europe/Warsaw', new Date('2026-03-10T23:00:00Z'));
    expect(later.from.toISOString()).toBe('2026-03-04T23:00:00.000Z');
  });

  test('zones behind UTC, half-hour zones and clock changes', () => {
    expect(zonedDay(now, 'America/Los_Angeles')).toEqual([2026, 3, 10]);
    expect(zonedDay(now, 'Asia/Kolkata')).toEqual([2026, 3, 11]);
    expect(zonedDayStart(2026, 3, 11, 'Asia/Kolkata').toISOString()).toBe('2026-03-10T18:30:00.000Z');
    // Clocks go forward in Warsaw on 29 March 2026: that day has 23 hours.
    const day = zonedDayStart(2026, 3, 29, 'Europe/Warsaw');
    const next = zonedDayStart(2026, 3, 30, 'Europe/Warsaw');
    expect(day.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect((next.getTime() - day.getTime()) / 3600000).toBe(23);
    // Day numbers roll over months.
    expect(zonedDayStart(2026, 3, 0, 'UTC').toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  test('custom ranges and their refusals', () => {
    const range = resolveDateRangeInZone({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }, 'Europe/Warsaw');
    expect(range.from.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(daysIn(range)).toBe(31);
    for (const bad of [
      { preset: 'custom' as const },
      { preset: 'custom' as const, from: '2026-02-01', to: '2026-01-01' },
      { preset: 'custom' as const, from: '2024-01-01', to: '2026-01-01' },
      { preset: 'custom' as const, from: 'yesterday', to: '2026-01-01' },
      { preset: 'nonsense' as never },
    ]) {
      expect(() => resolveDateRangeInZone(bad, 'Europe/Warsaw')).toThrow();
    }
    expect(resolveDateRangeInZone({ preset: 'allTime' }, 'Europe/Warsaw', now).from.getTime()).toBe(0);
  });
});

describe('against the database', () => {
  let owner: { id: string; email: string };
  let projectId: string;
  let organizationId: string;
  let callId: string;

  beforeEach(async () => {
    await resetDb();
    owner = await makeUser('Owner');
    ({ projectId } = await seed());
    [{ organizationId }] = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId));
    [{ id: callId }] = await db
      .select({ id: calls.id })
      .from(calls)
      .where(eq(calls.originalFilename, 'broadband-outage.wav'));
    await signIn(owner.email);
  });

  test('the overview has one point per local day, the last one today', async () => {
    await db.update(userTable).set({ timeZone: 'Pacific/Auckland' }).where(eq(userTable.id, owner.id));
    const volume = await getDashboardCallVolume(projectId, { preset: 'last7days' });
    expect(volume.data).toHaveLength(7);
    const [y, m, d] = zonedDay(new Date(), 'Pacific/Auckland');
    expect(volume.data.at(-1)!.date).toBe(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    expect(volume.data.reduce((n, p) => n + p.count, 0)).toBe(3);
    // A bad range from the browser is refused, not a crash.
    await expect(getDashboardCallVolume(projectId, { preset: 'custom', from: 'x', to: 'y' })).rejects.toMatchObject({
      status: 400,
    });
  });

  test('the calls list pages through its rows', async () => {
    const first = await getCallsFiltered(projectId, { page: 1, pageSize: 2 });
    const second = await getCallsFiltered(projectId, { page: 2, pageSize: 2 });
    expect(first).toMatchObject({ total: 3, totalPages: 2, page: 1 });
    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((c) => c.id)).size).toBe(3);
    // Past the end: no rows, the same total.
    expect(await getCallsFiltered(projectId, { page: 9, pageSize: 2 })).toMatchObject({ data: [], total: 3 });
    // Tasks count pages from zero.
    expect((await listActionItems(projectId, { page: 0, pageSize: 2 })).items).toHaveLength(2);
    expect((await listActionItems(projectId, { page: 1, pageSize: 2 })).items).toHaveLength(1);
  });

  test('the only organisation cannot be deleted; a project can, and the owner is led back in', async () => {
    expect(await deleteOrganization(organizationId)).toEqual({
      ok: false,
      error: "This is the only organization of this install, so it can't be deleted.",
    });
    await deleteProject(projectId);
    expect(await landingFor(owner.id)).toEqual({ kind: 'no-project', orgRole: 'OWNER', organizationId });

    // With a second organisation (the commercial fork), the owner may delete one of them.
    const other = await makeOrg(owner);
    expect(await deleteOrganization(other)).toEqual({ ok: true, data: undefined });
    const admin = await makeUser('Admin');
    await addMember(organizationId, admin, 'ADMIN');
    await signIn(admin.email);
    expect(await deleteOrganization(organizationId)).toMatchObject({ ok: false });
  });

  test('a stored key does not follow a connection to another host', async () => {
    const made = await createProviderConnection(organizationId, {
      name: 'OpenAI',
      kind: 'llm',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-secret-value',
      dataLocation: 'us',
    });
    if (!made.ok) throw new Error(made.error);
    // Another path on the same host keeps the key.
    expect(await updateProviderConnection(made.data.id, { baseUrl: 'https://api.openai.com/v2' })).toMatchObject({
      ok: true,
      data: { hasApiKey: true },
    });
    // Same host, another scheme or port: the key would go in clear text, or to another service.
    for (const baseUrl of ['http://api.openai.com/v2', 'https://api.openai.com:8443/v2']) {
      expect(await updateProviderConnection(made.data.id, { baseUrl })).toMatchObject({ ok: false });
    }
    expect(await updateProviderConnection(made.data.id, { baseUrl: 'http://127.0.0.1:9000/v1' })).toMatchObject({
      ok: false,
    });
    expect(
      await updateProviderConnection(made.data.id, { baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'sk-new' })
    ).toMatchObject({ ok: true, data: { baseUrl: 'http://127.0.0.1:9000/v1', hasApiKey: true } });
    expect(
      await updateProviderConnection(made.data.id, { baseUrl: 'http://whisper:8000/v1', removeKey: true })
    ).toMatchObject({ ok: true, data: { hasApiKey: false } });
    // Cloud metadata addresses are never a provider.
    for (const url of ['http://169.254.169.254/latest', 'http://[fe80::1]/v1', 'http://[::ffff:169.254.169.254]/v1']) {
      expect(cleanBaseUrl(url)).toEqual({ problem: 'host_not_allowed' });
    }
  });

  test('a viewer sees what the project uses, not every connection of the organisation', async () => {
    const ids: string[] = [];
    for (const name of ['Used', 'Spare']) {
      const made = await createProviderConnection(organizationId, {
        name,
        kind: 'speech',
        baseUrl: 'http://whisper:8000/v1',
        dataLocation: 'own_network',
      });
      if (!made.ok) throw new Error(made.error);
      ids.push(made.data.id);
    }
    await setProjectProvider(projectId, 'speech', ids[0], 'whisper-1');
    expect((await getProjectProviders(projectId)).options.map((o) => o.name).sort()).toEqual(['Spare', 'Used']);
    const viewer = await makeUser('Viewer');
    await addMember(organizationId, viewer, 'MEMBER');
    await signIn(viewer.email);
    const seen = await getProjectProviders(projectId);
    expect(seen.options.map((o) => o.name)).toEqual(['Used']);
    expect(seen.choices).toHaveLength(1);
  });

  test('the upload gate needs an active template; the first template made is active', async () => {
    const [seeded] = await getAnalysisTemplates(projectId);
    await deleteAnalysisTemplate(projectId, seeded.id);
    expect(await getProjectReadiness(projectId)).toMatchObject({ templates: false, canUpload: false });
    const first = await createAnalysisTemplate(projectId, { name: 'First', fields: [] });
    const second = await createAnalysisTemplate(projectId, { name: 'Second', fields: [] });
    expect(first).toMatchObject({ ok: true, data: { isActive: true } });
    expect(second).toMatchObject({ ok: true, data: { isActive: false } });
    expect(await getProjectReadiness(projectId)).toMatchObject({ templates: true });
  });

  test('speaker presets: results a form can show, and one default at a time', async () => {
    const taken = await createSpeakerPreset(projectId, { name: 'Agent and customer', speakers: ['A', 'B'] });
    expect(taken).toEqual({ ok: false, error: 'This name is already used.' });
    expect(await createSpeakerPreset(projectId, { name: 'Same', speakers: ['Agent', 'agent'] })).toMatchObject({
      ok: false,
    });
    const made = await createSpeakerPreset(projectId, { name: 'Sales', speakers: [' Seller ', 'Buyer', ''] });
    if (!made.ok) throw new Error(made.error);
    expect(made.data).toMatchObject({ speakers: ['Seller', 'Buyer'], isDefault: false });
    expect(await updateSpeakerPreset(projectId, { id: made.data.id, name: 'Agent and customer' })).toMatchObject({
      ok: false,
    });

    // Both asked at once: exactly one stays default.
    const [seeded] = (await getSpeakerPresets(projectId)).filter((p) => p.isDefault);
    await Promise.all([
      setDefaultSpeakerPreset(projectId, made.data.id),
      setDefaultSpeakerPreset(projectId, seeded.id),
      setDefaultSpeakerPreset(projectId, made.data.id),
    ]);
    const defaults = await db.select().from(speakerPresets).where(eq(speakerPresets.isDefault, true));
    expect(defaults).toHaveLength(1);

    expect(await deleteSpeakerPreset(projectId, made.data.id)).toEqual({ ok: true, data: undefined });
    expect(await deleteSpeakerPreset(projectId, made.data.id)).toMatchObject({ ok: false });
  });

  test('a later result replaces the stored one; a failed one leaves it alone', async () => {
    const fixed = JSON.parse(
      await readFile(path.join(__dirname, '../../../../tests/fixtures/fixed-result.json'), 'utf8')
    ) as ResultBody;
    const run = async (body: ResultBody) => {
      await db.update(jobs).set({ status: 'superseded' }).where(eq(jobs.callId, callId));
      const [job] = await db.insert(jobs).values({ callId, attempt: 1, status: 'sent' }).returning({ id: jobs.id });
      await db.transaction((tx) => storeResult(tx, { callId, projectId, jobId: job.id, model: 'm2' }, body));
    };

    await run({ job_id: 'x', attempt: 1, status: 'failed', steps: [], error: { step: 'decode', code: 'internal' } });
    const kept = (await getCallById(projectId, callId))!;
    expect(kept).toMatchObject({ status: 'completed', language: 'en', laterRun: { status: 'failed' } });
    expect(kept.turns).toHaveLength(6);

    await run(fixed);
    const replaced = (await getCallById(projectId, callId))!;
    expect(replaced).toMatchObject({ status: 'completed', language: 'pl', laterRun: null });
    expect(replaced.turns).toHaveLength(4);
    expect(replaced.turns[0].text).toContain('[OSOBA_1]');
    // No scorecard in the new result, so none is shown; one row per kind, ranges and tasks replaced.
    expect(replaced.templateAnalysis).toBeUndefined();
    expect(await db.select().from(analyses).where(eq(analyses.callId, callId))).toHaveLength(2);
    expect(await db.select().from(piiRanges).where(eq(piiRanges.callId, callId))).toHaveLength(2);
    expect(await db.select().from(actionItems).where(eq(actionItems.callId, callId))).toHaveLength(1);
  });
});
