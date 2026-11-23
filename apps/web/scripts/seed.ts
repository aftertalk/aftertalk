// Development and tests only (item 56a): one organisation, one project with call reasons and an
// active scorecard template, and three calls from tests/fixtures/seed-calls.json:
//   1. completed, with personal-data ranges and quotes (English);
//   2. completed with errors: the scorecard failed (Polish);
//   3. no stored result: its only job failed.
// Run from the repo root with `pnpm --filter web seed`, with the dev Postgres up. Running it again
// replaces the seeded organisation. It refuses to run when NODE_ENV is `production`.
//
// The owner is the first user of the install; when there is none, the script makes
// `seed@example.com` with the password in SEED_PASSWORD (default: the one printed at the end).
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';

if (process.env.NODE_ENV === 'production') {
  console.error('The seed script is for development and tests. It does not run in production.');
  process.exit(1);
}

// Run on its own (not under Jest), the script is outside Next, where the 'server-only' marker that
// lib/ files import throws by design. It marks nothing here, so it loads as an empty module.
if (require.main === module) {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = loader._load;
  loader._load = (request, ...rest) => (request === 'server-only' ? {} : load(request, ...rest));
}

// The defaults of docker-compose.dev.yml, so the script runs with no .env file.
const repoRoot = path.resolve(__dirname, '../../..');
(process.env as Record<string, string | undefined>).NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://aftertalk:aftertalk@127.0.0.1:5433/aftertalk';
process.env.DATA_DIR ??= path.join(repoRoot, 'data');
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'dev-better-auth-secret-change-me-0000';
process.env.SECRETS_KEY ??= 'ZGV2LXNlY3JldHMta2V5LWNoYW5nZS1tZS0wMDAwMDA=';
process.env.ENGINE_URL ??= 'http://127.0.0.1:8000';
process.env.ENGINE_CALLBACK_SECRET ??= 'dev-callback-secret-change-me';

export const SEED_ORG_NAME = 'Seed organisation';
const SEED_EMAIL = 'seed@example.com';

// The ids the fixture bodies name (call reasons and scorecard fields).
const CATEGORY = {
  billing: '11111111-1111-4111-8111-111111111101',
  fault: '11111111-1111-4111-8111-111111111102',
  outage: '11111111-1111-4111-8111-111111111103',
  complaint: '11111111-1111-4111-8111-111111111104',
};
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222201';
const FIELD = {
  resolved: '22222222-2222-4222-8222-222222222211',
  mood: '22222222-2222-4222-8222-222222222212',
  note: '22222222-2222-4222-8222-222222222213',
};

/** One second of a quiet 440 Hz tone, 8 kHz mono 16-bit: enough for the player to load and seek. */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function seed(): Promise<{ projectId: string; email: string | null; password: string | null }> {
  // Imported here, after the environment defaults above are in place.
  const { asc, eq } = await import('drizzle-orm');
  const { createHash } = await import('node:crypto');
  const { db } = await import('@/lib/db/client');
  const schema = await import('@/lib/db/schema/app');
  const { user: userTable } = await import('@/lib/db/schema/auth');
  const { createUser } = await import('@/lib/auth/create-user');
  const { deleteOrganization } = await import('@/lib/deletion');
  const { storeResult } = await import('@/lib/jobs/store-result');
  const bodies = (await import('../../../tests/fixtures/seed-calls.json')).default as unknown as Array<
    import('@/lib/jobs/store-result').ResultBody
  >;

  // Run again: start from nothing.
  const old = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.name, SEED_ORG_NAME));
  for (const { id } of old) await deleteOrganization(id);

  let [owner] = await db.select({ id: userTable.id }).from(userTable).orderBy(asc(userTable.createdAt)).limit(1);
  let email: string | null = null;
  let password: string | null = null;
  if (!owner) {
    email = SEED_EMAIL;
    password = process.env.SEED_PASSWORD ?? randomBytes(12).toString('base64url');
    owner = await createUser({ email, name: 'Seed Owner', password });
  }

  const audio = toneWav(30);
  const sha = createHash('sha256').update(audio).digest('hex');
  const files: { callId: string }[] = [];

  const projectId = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: SEED_ORG_NAME, createdBy: owner.id })
      .returning({ id: schema.organizations.id });
    await tx.insert(schema.organizationMembers).values({ organizationId: org.id, userId: owner.id, role: 'OWNER' });
    const [project] = await tx
      .insert(schema.projects)
      .values({ organizationId: org.id, name: 'Seed project', allowedLanguages: ['en', 'pl'] })
      .returning({ id: schema.projects.id });

    await tx.insert(schema.speakerPresets).values({
      projectId: project.id,
      userId: owner.id,
      name: 'Agent and customer',
      speakers: ['Agent', 'Customer'],
      isDefault: true,
    });

    const [taxonomy] = await tx
      .insert(schema.taxonomies)
      .values({ projectId: project.id, userId: owner.id })
      .returning({ id: schema.taxonomies.id });
    await tx.insert(schema.categories).values([
      {
        id: CATEGORY.billing,
        taxonomyId: taxonomy.id,
        name: 'Billing',
        description: 'Invoices and payments',
        displayOrder: 0,
      },
      {
        id: CATEGORY.fault,
        taxonomyId: taxonomy.id,
        name: 'Fault',
        description: 'Something does not work',
        displayOrder: 1,
      },
      {
        id: CATEGORY.complaint,
        taxonomyId: taxonomy.id,
        name: 'Complaint',
        description: 'A formal complaint',
        displayOrder: 2,
      },
    ]);
    await tx.insert(schema.categories).values({
      id: CATEGORY.outage,
      taxonomyId: taxonomy.id,
      parentId: CATEGORY.fault,
      name: 'Outage',
      description: 'The service is down',
      displayOrder: 0,
    });

    await tx
      .insert(schema.analysisTemplates)
      .values({ id: TEMPLATE_ID, projectId: project.id, userId: owner.id, name: 'General QA', isActive: true });
    await tx.insert(schema.analysisTemplateFields).values([
      {
        id: FIELD.resolved,
        templateId: TEMPLATE_ID,
        label: 'Issue resolved on the call',
        prompt: 'Was the customer’s issue resolved before the call ended?',
        answerType: 'BOOLEAN',
        displayOrder: 0,
      },
      {
        id: FIELD.mood,
        templateId: TEMPLATE_ID,
        label: 'Customer mood at the end',
        prompt: 'How did the customer sound at the end of the call?',
        answerType: 'CHOICE',
        options: ['Satisfied', 'Neutral', 'Unhappy'],
        displayOrder: 1,
      },
      {
        id: FIELD.note,
        templateId: TEMPLATE_ID,
        label: 'Short note',
        prompt: 'Describe the call in one sentence.',
        answerType: 'TEXT',
        displayOrder: 2,
      },
    ]);

    const names = ['broadband-outage.wav', 'reklamacja-faktury.wav', 'bad-key.wav'];
    for (const [i, body] of bodies.entries()) {
      const [call] = await tx
        .insert(schema.calls)
        .values({
          projectId: project.id,
          uploadedBy: owner.id,
          originalFilename: names[i],
          contentType: 'audio/wav',
          sizeBytes: audio.length,
          audioSha256: sha,
          // Spread over the last days, so the overview has more than one point.
          createdAt: new Date(Date.now() - (bodies.length - i) * 24 * 60 * 60 * 1000),
        })
        .returning({ id: schema.calls.id });
      // The job id of the fixture is a placeholder: a second seed run would collide with it.
      const [job] = await tx
        .insert(schema.jobs)
        .values({ callId: call.id, attempt: 1, status: 'sent', sentAt: new Date() })
        .returning({ id: schema.jobs.id });
      await storeResult(tx, { callId: call.id, projectId: project.id, jobId: job.id, model: 'seed-model' }, body);
      files.push({ callId: call.id });
    }
    return project.id;
  });

  // After the commit, like an upload: a file with no call is swept, a call with no file plays nothing.
  const dir = path.join(process.env.DATA_DIR!, 'audio');
  await mkdir(dir, { recursive: true });
  for (const { callId } of files) await writeFile(path.join(dir, callId), audio);

  return { projectId, email, password };
}

if (require.main === module) {
  seed()
    .then(({ projectId, email, password }) => {
      console.log(`Seeded project: ${process.env.PUBLIC_URL}/${projectId}/home`);
      if (email) console.log(`Sign in as ${email} with the password ${password}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
