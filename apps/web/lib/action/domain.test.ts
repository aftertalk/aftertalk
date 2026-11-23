// Phase 2 against the database: the three seeded calls as the pages load them, what stays redacted,
// who may do what (the rows of the role-by-action table), and that nothing crosses organisations.
import { existsSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { GET as audioGET } from '@/app/api/calls/[callId]/audio/route';
import { GET as exportGET } from '@/app/api/projects/[projectId]/export/route';
import { POST as uploadPOST } from '@/app/api/upload/route';
import { db, sql } from '@/lib/db/client';
import { calls, jobs, piiAccessLog, projects } from '@/lib/db/schema/app';
import { runRetention } from '@/lib/jobs/retention';
import { seed } from '@/scripts/seed';
import { addMember, addProjectMember, makeOrg, makeProject, makeUser, resetDb, signIn } from '@/test/fixtures';

import { listActionItems, updateActionItem } from './action-items';
import { activateAnalysisTemplate, getAnalysisTemplates, updateAnalysisTemplate } from './analysis-templates';
import { getDashboardCallVolume, getDashboardMetrics, getDashboardSentiment } from './dashboard';
import { getProjectProviders, getProjectReadiness, setProjectProvider } from './project-providers';
import { deleteProject, getProjects, updateProject } from './projects';
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from './providers';
import { ForbiddenError, NotFoundError } from './result';
import { createCategory, getTaxonomy, moveCategory } from './taxonomy';
import {
  deleteTranscript,
  getCallById,
  getCallsFiltered,
  getOriginalTranscript,
  getPiiAccessLog,
  searchCalls,
  setCallCategory,
} from './transcription';

jest.mock('next-intl/server', () => jest.requireActual('@/test/intl-server'));

const DATA_DIR = process.env.DATA_DIR!;
const PRIVATE = ['Emma', 'Clarke', 'Daniel', 'Reed', '07700', '900123', 'Nowak', 'Wiśniewski'];

type World = {
  projectId: string;
  organizationId: string;
  owner: { id: string; email: string };
  admin: { id: string; email: string };
  editor: { id: string; email: string };
  viewer: { id: string; email: string };
  outsider: { id: string; email: string };
  /** completed (English), completed with errors (Polish), failed. */
  callIds: [string, string, string];
};

let w: World;

beforeEach(async () => {
  await resetDb();
  // Files of earlier tests would be counted by the sweep.
  await rm(DATA_DIR, { recursive: true, force: true });
  const owner = await makeUser('Owner');
  const { projectId } = await seed();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const organizationId = project.organizationId;
  const [admin, editor, viewer, outsider] = await Promise.all([
    makeUser('Admin'),
    makeUser('Editor'),
    makeUser('Viewer'),
    makeUser('Outsider'),
  ]);
  await addMember(organizationId, admin, 'ADMIN');
  await addMember(organizationId, editor, 'MEMBER');
  await addMember(organizationId, viewer, 'MEMBER');
  await addProjectMember(projectId, editor, 'EDITOR');
  // The viewer has the project's default role (VIEWER, visibility ORG). The outsider owns another organisation.
  await makeProject(await makeOrg(outsider));
  const rows = await db
    .select({ id: calls.id, name: calls.originalFilename })
    .from(calls)
    .where(eq(calls.projectId, projectId));
  const id = (name: string) => rows.find((r) => r.name === name)!.id;
  w = {
    projectId,
    organizationId,
    owner,
    admin,
    editor,
    viewer,
    outsider,
    callIds: [id('broadband-outage.wav'), id('reklamacja-faktury.wav'), id('bad-key.wav')],
  };
});

afterAll(async () => {
  await sql.end({ timeout: 2 });
});

describe('the seeded calls as pages load them', () => {
  test('the list shows the three statuses, titles, reasons and task counts', async () => {
    await signIn(w.viewer.email);
    const page = await getCallsFiltered(w.projectId, { page: 1, pageSize: 25 });
    expect(page.total).toBe(3);
    const byId = new Map(page.data.map((c) => [c.id, c]));
    expect(byId.get(w.callIds[0])).toMatchObject({
      status: 'completed',
      title: 'Broadband outage, engineer booked',
      primaryCategory: 'Outage',
      sentimentLevel: 'positive',
      actionItemsCount: 2,
      language: 'en',
      laterRun: null,
    });
    expect(byId.get(w.callIds[1])).toMatchObject({ status: 'completed_with_errors', primaryCategory: 'Complaint' });
    expect(byId.get(w.callIds[2])).toMatchObject({ status: 'failed', failedReason: 'provider_auth', language: '' });
  });

  test('the call page is redacted for every role, the owner included', async () => {
    for (const user of [w.owner, w.viewer]) {
      await signIn(user.email);
      for (const callId of w.callIds.slice(0, 2)) {
        const call = (await getCallById(w.projectId, callId))!;
        const json = JSON.stringify(call);
        for (const word of PRIVATE) expect(json).not.toContain(word);
      }
    }
    const call = (await getCallById(w.projectId, w.callIds[0]))!;
    expect(call.turns[0].text).toBe('Good morning, Northline support, this is [PERSON_1] How can I help?');
    expect(call.turns[3].text).toBe('Yes, it is [PHONE_1]');
    expect(call.turns[1]).toMatchObject({ index: 2, speakerId: 'customer' });
    expect(call.piiStatistics).toEqual({ totalDetected: 4, types: { PERSON: 3, PHONE: 1 } });
    expect(call.speakers.map((s) => s.name)).toEqual(['Agent', 'Customer']);
  });

  test('quotes are the transcript words of their range; an unverified one has none', async () => {
    await signIn(w.viewer.email);
    const call = (await getCallById(w.projectId, w.callIds[0]))!;
    expect(call.summary!.sentiment!.evidence).toEqual([
      expect.objectContaining({ turn: 6, match: 'verbatim', text: 'thanks for the quick help.' }),
    ]);
    const [first, second] = call.summary!.actionItems;
    expect(first.quote).toMatchObject({ turn: 5, text: 'An engineer will call you tomorrow before noon.' });
    expect(first.quote!.startMs).toBeGreaterThan(0);
    expect(second.quote).toMatchObject({ match: 'unverified', text: null, startWord: null, startMs: null });
    const scorecard = call.templateAnalysis!;
    expect(scorecard.templateName).toBe('General QA');
    expect(scorecard.results.map((r) => [r.label, r.value, r.evidence.length])).toEqual([
      ['Issue resolved on the call', false, 1],
      ['Customer mood at the end', 'Satisfied', 1],
      ['Short note', 'Outage reported; engineer call booked for the next morning.', 0],
    ]);
    expect(call.classification!.primary).toMatchObject({
      categoryNames: ['Fault', 'Outage'],
      explanation: 'The customer says the internet has been down since yesterday.',
    });
    expect(call.steps.map((s) => s.name)).toContain('transcribe');
    expect(call.steps.find((s) => s.name === 'summary')).toMatchObject({ tokensIn: 512, tokensOut: 188 });
  });

  test('a failed analysis and a failed call say why', async () => {
    await signIn(w.viewer.email);
    const withErrors = (await getCallById(w.projectId, w.callIds[1]))!;
    expect(withErrors.templateAnalysis).toBeUndefined();
    expect(withErrors.failedAnalyses).toEqual([{ kind: 'scorecard', errorCode: 'provider_output_invalid' }]);
    expect(withErrors.steps.find((s) => s.name === 'transcribe')!.cached).toBe(true);
    const failed = (await getCallById(w.projectId, w.callIds[2]))!;
    expect(failed).toMatchObject({ status: 'failed', failedReason: 'provider_auth', turns: [], canPlayAudio: false });
    expect(failed.steps.at(-1)).toMatchObject({ status: 'failed', errorCode: 'provider_auth' });
  });

  test('a later run is a note on a call that keeps its result', async () => {
    await db.insert(jobs).values({ callId: w.callIds[0], attempt: 1, status: 'queued' });
    await signIn(w.viewer.email);
    const call = (await getCallById(w.projectId, w.callIds[0]))!;
    expect(call).toMatchObject({ status: 'completed', laterRun: { status: 'queued' } });
    expect(call.turns.length).toBe(6);
  });

  test('search reads redacted text only', async () => {
    await signIn(w.viewer.email);
    const hit = await searchCalls(w.projectId, { q: 'engineer', page: 1, pageSize: 25 });
    expect(hit.data.map((c) => c.id)).toEqual([w.callIds[0]]);
    expect(hit.data[0].snippet).toContain('<mark>engineer</mark>');
    for (const q of ['Reed', 'Wiśniewski', '07700']) {
      expect((await searchCalls(w.projectId, { q, page: 1, pageSize: 25 })).total).toBe(0);
    }
    // LIKE wildcards in the query are literal.
    expect((await searchCalls(w.projectId, { q: '%', page: 1, pageSize: 25 })).total).toBe(0);
    expect((await searchCalls(w.projectId, { q: '[PERSON_1]', page: 1, pageSize: 25 })).total).toBe(1);
  });

  test('tasks and the overview', async () => {
    await signIn(w.viewer.email);
    const tasks = await listActionItems(w.projectId, { pageSize: 50 });
    expect(tasks).toMatchObject({ totalCount: 3, pendingCount: 3, doneCount: 0 });
    expect(JSON.stringify(tasks)).not.toContain('Reed');
    // The tabs of the Tasks page filter by status; the counts still describe the whole list.
    const pending = await listActionItems(w.projectId, { status: ['PENDING'], priority: ['MEDIUM', 'HIGH'] });
    expect(pending).toMatchObject({ totalCount: 3, pendingCount: 3 });
    expect(pending.items).toHaveLength(3);
    expect((await listActionItems(w.projectId, { status: ['DONE', 'CANCELLED'] })).items).toEqual([]);
    expect(
      (await listActionItems(w.projectId, { search: 'ENGINEER', sortBy: 'PRIORITY', sortDir: 'ASC' })).items
    ).toHaveLength(1);
    const metrics = await getDashboardMetrics(w.projectId, { preset: 'last7days' });
    expect(metrics).toMatchObject({ totalCalls: 3, positiveSentimentPercent: 50, pendingActionItems: 3 });
    const sentiment = await getDashboardSentiment(w.projectId, { preset: 'last7days' });
    expect(sentiment.distribution).toMatchObject({ positive: 1, negative: 1, total: 2 });
    const volume = await getDashboardCallVolume(w.projectId, { preset: 'allTime' });
    expect(volume.data.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(volume.data.length).toBeLessThan(10);
  });
});

describe('original text and audio', () => {
  test('owners and admins always; members only when the project is "full"; each use is logged', async () => {
    await signIn(w.editor.email);
    const shown = await getOriginalTranscript(w.projectId, w.callIds[0]);
    expect(shown.ok && shown.data[1].text).toBe(
      'Hi, my name is Daniel Reed. My internet has been down since yesterday evening.'
    );
    // Only organisation admins read the log.
    expect(await getPiiAccessLog(w.projectId, w.callIds[0])).toMatchObject({ ok: false });

    await db.update(projects).set({ memberPiiAccess: 'strict' }).where(eq(projects.id, w.projectId));
    expect(await getOriginalTranscript(w.projectId, w.callIds[0])).toEqual({ ok: false, error: 'Forbidden' });
    const strict = (await getCallById(w.projectId, w.callIds[0]))!;
    expect(strict).toMatchObject({ canShowOriginal: false, canPlayAudio: false });

    await signIn(w.admin.email);
    expect((await getOriginalTranscript(w.projectId, w.callIds[0])).ok).toBe(true);
    const log = await getPiiAccessLog(w.projectId, w.callIds[0]);
    expect(log.ok && log.data.map((e) => [e.userName, e.kind])).toEqual([
      ['Admin', 'text'],
      ['Editor', 'text'],
    ]);
  });

  const audio = (callId: string, range?: string) =>
    audioGET(new Request(`http://localhost/api/calls/${callId}/audio`, { headers: range ? { range } : {} }), {
      params: Promise.resolve({ callId }),
    });

  test('the audio route: whole file, a range, one log row an hour, and its refusals', async () => {
    await signIn(w.editor.email);
    const whole = await audio(w.callIds[0]);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/wav');
    expect(whole.headers.get('cache-control')).toContain('no-store');
    const size = Number(whole.headers.get('content-length'));
    expect((await whole.arrayBuffer()).byteLength).toBe(size);

    const part = await audio(w.callIds[0], 'bytes=100-199');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await audio(w.callIds[0], `bytes=${size}-`)).status).toBe(416);

    const rows = await db.select().from(piiAccessLog).where(eq(piiAccessLog.callId, w.callIds[0]));
    expect(rows.filter((r) => r.kind === 'audio')).toHaveLength(1);

    // No stored result: 404 for everyone, the owner included.
    await signIn(w.owner.email);
    expect((await audio(w.callIds[2])).status).toBe(404);
    expect((await audio('not-a-uuid')).status).toBe(404);

    await db.update(projects).set({ memberPiiAccess: 'strict' }).where(eq(projects.id, w.projectId));
    await signIn(w.viewer.email);
    expect((await audio(w.callIds[0])).status).toBe(403);
    await signIn(w.outsider.email);
    expect((await audio(w.callIds[0])).status).toBe(404);
  });
});

describe('who may do what', () => {
  test('a viewer reads; an editor changes reasons and tasks; an admin deletes and configures', async () => {
    await signIn(w.viewer.email);
    expect(await setCallCategory(w.projectId, w.callIds[0], null)).toEqual({ ok: false, error: 'Forbidden' });
    const [task] = (await listActionItems(w.projectId)).items;
    await expect(
      updateActionItem(w.projectId, task.id, { status: 'DONE', clearNotes: false, clearDeadline: false })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await createCategory(w.projectId, { name: 'X', description: '' })).toMatchObject({ ok: false });
    expect(await updateProject(w.projectId, { name: 'X' })).toMatchObject({ ok: false });

    await signIn(w.editor.email);
    const taxonomy = await getTaxonomy(w.projectId);
    const billing = taxonomy.find((c) => c.name === 'Billing')!;
    expect(await setCallCategory(w.projectId, w.callIds[0], billing.id)).toEqual({ ok: true, data: undefined });
    // Set by hand: shown in place of the model's reason.
    expect((await getCallById(w.projectId, w.callIds[0]))!.primaryCategory).toBe('Billing');
    const done = await updateActionItem(w.projectId, task.id, {
      status: 'DONE',
      clearNotes: false,
      clearDeadline: false,
    });
    expect(done.status).toBe('DONE');
    expect(done.completedAt).toBeDefined();
    // Deleting a call needs a project admin (#46), and so do project settings.
    await expect(deleteTranscript(w.projectId, w.callIds[0])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await updateProject(w.projectId, { retentionDays: 30 })).toMatchObject({ ok: false });
    await expect(deleteProject(w.projectId)).rejects.toBeInstanceOf(ForbiddenError);

    await signIn(w.admin.email);
    expect(await updateProject(w.projectId, { retentionDays: 30, allowedLanguages: ['pl'] })).toMatchObject({
      ok: true,
      data: { retentionDays: 30, allowedLanguages: ['pl'], defaultLanguage: 'pl' },
    });
    expect(await updateProject(w.projectId, { allowedLanguages: [] })).toMatchObject({ ok: false });
    expect(await updateProject(w.projectId, { allowedLanguages: ['fr'] })).toMatchObject({ ok: false });
    expect(await updateProject(w.projectId, { retentionDays: 0 })).toMatchObject({ ok: false });
    await deleteTranscript(w.projectId, w.callIds[0]);
    expect(await getCallById(w.projectId, w.callIds[0])).toBeNull();
    expect(existsSync(path.join(DATA_DIR, 'audio', w.callIds[0]))).toBe(false);
    expect(existsSync(path.join(DATA_DIR, 'audio', w.callIds[1]))).toBe(true);
  });

  test('only organisation admins change who sees personal data', async () => {
    // A project admin who is an ordinary organisation member.
    await addProjectMember(w.projectId, w.viewer, 'ADMIN');
    await signIn(w.viewer.email);
    expect(await updateProject(w.projectId, { name: 'Renamed' })).toMatchObject({ ok: true });
    expect(await updateProject(w.projectId, { memberPiiAccess: 'strict' })).toEqual({ ok: false, error: 'Forbidden' });
    await signIn(w.admin.email);
    expect(await updateProject(w.projectId, { memberPiiAccess: 'strict' })).toMatchObject({
      ok: true,
      data: { memberPiiAccess: 'strict' },
    });
  });

  test('another organisation sees nothing: every id answers "not found"', async () => {
    await signIn(w.outsider.email);
    expect((await getProjects()).map((p) => p.id)).not.toContain(w.projectId);
    await expect(getCallsFiltered(w.projectId, { page: 1, pageSize: 25 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCallById(w.projectId, w.callIds[0])).rejects.toBeInstanceOf(NotFoundError);
    await expect(listActionItems(w.projectId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTaxonomy(w.projectId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProviderConnections(w.organizationId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getOriginalTranscript(w.projectId, w.callIds[0])).toEqual({ ok: false, error: 'Not found' });
    const exported = await exportGET(new Request(`http://localhost/api/projects/${w.projectId}/export`), {
      params: Promise.resolve({ projectId: w.projectId }),
    });
    expect(exported.status).toBe(404);

    // A call id of one project asked for through another project of the same user.
    await signIn(w.owner.email);
    const other = await makeProject(w.organizationId);
    expect(await getCallById(other, w.callIds[0])).toBeNull();
    expect(await setCallCategory(other, w.callIds[0], null)).toEqual({ ok: false, error: 'Not found' });
    await expect(getCallById(w.projectId, "'; drop table app.calls; --")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('export', () => {
  test('editors get the filtered calls as JSON, always redacted', async () => {
    const get = (query = '') =>
      exportGET(new Request(`http://localhost/api/projects/${w.projectId}/export${query}`), {
        params: Promise.resolve({ projectId: w.projectId }),
      });
    await signIn(w.viewer.email);
    expect((await get()).status).toBe(403);

    await signIn(w.owner.email);
    const response = await get();
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="aftertalk-export-/);
    const text = await response.text();
    for (const word of PRIVATE) expect(text).not.toContain(word);
    const body = JSON.parse(text);
    expect(body.project).toEqual({ id: w.projectId, name: 'Seed project' });
    expect(body.calls.map((c: { status: string }) => c.status).sort()).toEqual([
      'completed',
      'completed_with_errors',
      'failed',
    ]);
    const first = body.calls.find((c: { id: string }) => c.id === w.callIds[0]);
    expect(first.turns[3]).toMatchObject({ index: 4, speaker: 'customer', text: 'Yes, it is [PHONE_1]' });
    expect(first.analyses.find((a: { kind: string }) => a.kind === 'summary').quotes).toContainEqual({
      claim_path: 'action_items.1',
      turn: 5,
      match: 'unverified',
      text: null,
    });
    expect(first.action_items).toHaveLength(2);

    const searched = JSON.parse(await (await get('?q=reklamacj')).text());
    expect(searched.calls.map((c: { id: string }) => c.id)).toEqual([w.callIds[1]]);
  });
});

describe('providers and readiness', () => {
  test('connections: the key is write-only, names are unique, one in use stays', async () => {
    await signIn(w.editor.email);
    await expect(getProviderConnections(w.organizationId)).rejects.toBeInstanceOf(ForbiddenError);

    await signIn(w.admin.email);
    const made = await createProviderConnection(w.organizationId, {
      name: 'OpenAI',
      kind: 'speech',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-secret-value',
      dataLocation: 'us',
    });
    if (!made.ok) throw new Error(made.error);
    expect(made.data).toMatchObject({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      hasApiKey: true,
      inUse: false,
    });
    expect(JSON.stringify(await getProviderConnections(w.organizationId))).not.toContain('sk-secret-value');
    const dup = await createProviderConnection(w.organizationId, {
      name: 'OpenAI',
      kind: 'llm',
      baseUrl: 'https://api.openai.com/v1',
      dataLocation: 'us',
    });
    expect(dup).toEqual({ ok: false, error: 'This name is already used.' });
    expect(
      await createProviderConnection(w.organizationId, {
        name: 'Bad',
        kind: 'llm',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        dataLocation: 'us',
      })
    ).toMatchObject({ ok: false });

    // An empty key keeps the stored one; removeKey clears it.
    expect(await updateProviderConnection(made.data.id, { name: 'OpenAI EU', dataLocation: 'eu' })).toMatchObject({
      ok: true,
      data: { name: 'OpenAI EU', hasApiKey: true, dataLocation: 'eu' },
    });
    expect(await updateProviderConnection(made.data.id, { removeKey: true })).toMatchObject({
      ok: true,
      data: { hasApiKey: false },
    });

    // A speech connection cannot fill the LLM slot; the right slot needs a model.
    expect(await setProjectProvider(w.projectId, 'llm', made.data.id, 'gpt')).toEqual({
      ok: false,
      error: 'Not found',
    });
    expect(await setProjectProvider(w.projectId, 'speech', made.data.id, ' ')).toMatchObject({ ok: false });
    expect(await setProjectProvider(w.projectId, 'speech', made.data.id, 'whisper-1')).toMatchObject({ ok: true });
    expect((await getProjectProviders(w.projectId)).choices).toEqual([
      { slot: 'speech', connectionId: made.data.id, model: 'whisper-1' },
    ]);
    expect(await deleteProviderConnection(made.data.id)).toMatchObject({ ok: false });
    expect(await setProjectProvider(w.projectId, 'speech', null)).toMatchObject({ ok: true });
    expect(await deleteProviderConnection(made.data.id)).toEqual({ ok: true, data: undefined });

    // A connection of another organisation is not one of ours, whoever asks.
    await signIn(w.outsider.email);
    expect(await updateProviderConnection(made.data.id, { name: 'Mine' })).toEqual({ ok: false, error: 'Not found' });
  });

  test('uploads open once the project has a speech and an LLM provider', async () => {
    await signIn(w.owner.email);
    expect(await getProjectReadiness(w.projectId)).toMatchObject({
      roles: true,
      templates: true,
      categories: true,
      speech: false,
      llm: false,
      canUpload: false,
    });
    const upload = (headers: Record<string, string>, body: Buffer) =>
      uploadPOST(
        new Request('http://localhost:3000/api/upload', {
          method: 'POST',
          headers: { 'x-aftertalk-project': w.projectId, 'content-length': String(body.length), ...headers },
          body,
          duplex: 'half',
        } as RequestInit)
      );
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)]);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav' }, wav)).status).toBe(409);

    for (const kind of ['speech', 'llm'] as const) {
      const made = await createProviderConnection(w.organizationId, {
        name: kind,
        kind,
        baseUrl: 'http://provider.test/v1',
        dataLocation: 'own_network',
      });
      if (!made.ok) throw new Error(made.error);
      await setProjectProvider(w.projectId, kind, made.data.id, 'model-1');
    }
    expect(await getProjectReadiness(w.projectId)).toMatchObject({ canUpload: true, diarization: false });

    const stored = await upload(
      {
        'x-aftertalk-filename': encodeURIComponent('zażółć gęślą.wav'),
        'x-aftertalk-channel-0': 'Agent',
        'x-aftertalk-channel-1': 'Customer',
      },
      wav
    );
    expect(stored.status).toBe(201);
    const { callId } = (await stored.json()) as { callId: string };
    const [call] = await db.select().from(calls).where(eq(calls.id, callId));
    expect(call).toMatchObject({
      originalFilename: 'zażółć gęślą.wav',
      status: 'pending',
      sizeBytes: wav.length,
      channelRoles: { channel_0: 'Agent', channel_1: 'Customer' },
    });
    expect(call.audioSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.select({ s: jobs.status, a: jobs.attempt }).from(jobs).where(eq(jobs.callId, callId))).toEqual([
      { s: 'queued', a: 1 },
    ]);
    expect(existsSync(path.join(DATA_DIR, 'audio', callId))).toBe(true);
    expect((await getCallById(w.projectId, callId))!.status).toBe('queued');

    // Refusals leave no call and no temporary file behind.
    const before = (await db.select({ id: calls.id }).from(calls)).length;
    expect((await upload({ 'x-aftertalk-filename': 'a.exe' }, wav)).status).toBe(415);
    expect((await upload({ 'x-aftertalk-filename': 'a.mp3' }, wav)).status).toBe(415);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav', 'x-aftertalk-channel-0': 'Agent' }, wav)).status).toBe(400);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav', 'content-length': '9999' }, wav)).status).toBe(400);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav', origin: 'https://evil.example' }, wav)).status).toBe(403);
    await signIn(w.viewer.email);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav' }, wav)).status).toBe(403);
    await signIn(w.outsider.email);
    expect((await upload({ 'x-aftertalk-filename': 'a.wav' }, wav)).status).toBe(404);
    expect((await db.select({ id: calls.id }).from(calls)).length).toBe(before);
  });
});

describe('templates and call reasons', () => {
  test('a field keeps its id when its label stays, so stored answers still find it', async () => {
    await signIn(w.editor.email);
    const [template] = await getAnalysisTemplates(w.projectId);
    const [resolved, mood] = template.fields;
    const updated = await updateAnalysisTemplate(w.projectId, template.id, {
      fields: [
        { label: mood.label, prompt: 'Changed prompt', answerType: 'CHOICE', options: ['Good', 'Bad'] },
        { label: 'A new question', prompt: 'Anything?', answerType: 'TEXT' },
      ],
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.data.fields.map((f) => f.label)).toEqual([mood.label, 'A new question']);
    expect(updated.data.fields[0].id).toBe(mood.id);
    expect(updated.data.fields.map((f) => f.id)).not.toContain(resolved.id);
    // The removed question leaves the stored scorecard; the kept one stays.
    const call = (await getCallById(w.projectId, w.callIds[0]))!;
    expect(call.templateAnalysis!.results.map((r) => r.label)).toEqual([mood.label]);

    expect(
      await updateAnalysisTemplate(w.projectId, template.id, {
        fields: [{ label: 'Pick', prompt: 'One', answerType: 'CHOICE', options: [] }],
      })
    ).toMatchObject({ ok: false });
    expect((await activateAnalysisTemplate(w.projectId, template.id)).isActive).toBe(true);
  });

  test('call reasons nest three levels and never under themselves', async () => {
    await signIn(w.editor.email);
    const tree = await getTaxonomy(w.projectId);
    const fault = tree.find((c) => c.name === 'Fault')!;
    const outage = fault.children![0];
    expect(fault.callCount).toBe(0);
    expect(outage.callCount).toBe(1);
    const third = await createCategory(w.projectId, { name: 'Fibre cut', description: '', parentId: outage.id });
    if (!third.ok) throw new Error(third.error);
    expect(
      await createCategory(w.projectId, { name: 'Too deep', description: '', parentId: third.data.id })
    ).toMatchObject({ ok: false });
    expect(await moveCategory(w.projectId, { id: fault.id, newParentId: third.data.id })).toMatchObject({ ok: false });
    const billing = tree.find((c) => c.name === 'Billing')!;
    // Fault is three levels tall already, so it fits nowhere but the top.
    expect(await moveCategory(w.projectId, { id: fault.id, newParentId: billing.id })).toMatchObject({ ok: false });
    expect(await moveCategory(w.projectId, { id: billing.id, newParentId: fault.id })).toMatchObject({ ok: true });
    expect(await createCategory(w.projectId, { name: 'Outage', description: '', parentId: fault.id })).toEqual({
      ok: false,
      error: 'This name is already used.',
    });
  });
});

describe('retention and the sweep', () => {
  test('old calls go with their audio; stray files and cache folders go; fresh uploads stay', async () => {
    const audioDir = path.join(DATA_DIR, 'audio');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const stray = path.join(audioDir, '99999999-9999-4999-8999-999999999999');
    const fresh = path.join(audioDir, 'tmp', 'in-progress');
    const staleTmp = path.join(audioDir, 'tmp', 'abandoned');
    await mkdir(path.join(audioDir, 'tmp'), { recursive: true });
    for (const file of [stray, fresh, staleTmp]) await writeFile(file, 'x');
    await utimes(stray, old, old);
    await utimes(staleTmp, old, old);
    const [{ sha }] = await db.select({ sha: calls.audioSha256 }).from(calls).where(eq(calls.id, w.callIds[0]));
    const cache = path.join(DATA_DIR, 'cache', w.organizationId);
    await mkdir(path.join(cache, sha), { recursive: true });
    await mkdir(path.join(cache, 'f'.repeat(64)), { recursive: true });
    await mkdir(path.join(DATA_DIR, 'cache', 'not-an-organisation'), { recursive: true });

    // Seven days of retention; one call is made ten days old, the others are a few days old.
    await db
      .update(calls)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) })
      .where(eq(calls.id, w.callIds[0]));
    await db.update(projects).set({ retentionDays: 7 }).where(eq(projects.id, w.projectId));
    const counts = await runRetention();
    expect(counts).toEqual({ calls: 1, audioFiles: 2, cacheFolders: 2 });
    expect(await db.select({ id: calls.id }).from(calls).where(eq(calls.id, w.callIds[0]))).toEqual([]);
    expect(existsSync(path.join(audioDir, w.callIds[0]))).toBe(false);
    expect(existsSync(path.join(audioDir, w.callIds[1]))).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // The three seeded calls share one recording, so its cache folder is still needed.
    expect(existsSync(path.join(cache, sha))).toBe(true);
    expect(existsSync(path.join(cache, 'f'.repeat(64)))).toBe(false);
  });
});
