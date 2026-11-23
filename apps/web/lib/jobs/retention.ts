// The hourly task of the "Deletion, retention and reprocessing" section (item 38c): delete calls past
// their project's retention, then remove audio files no call names and cache folders no call needs.
// One run at a time across processes, under a Postgres advisory lock of its own.
import 'server-only';

import { and, eq, isNotNull, lt, sql as dsql } from 'drizzle-orm';

import { db, sql } from '@/lib/db/client';
import { calls, organizations, projects } from '@/lib/db/schema/app';
import { deleteCall } from '@/lib/deletion';
import { log } from '@/lib/log';
import { fileInfo, list, remove } from '@/lib/storage';

const LOCK_KEY = 0x41667472; // "Aftr"; the job tick of phase 3 uses another key
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RetentionCounts = { calls: number; audioFiles: number; cacheFolders: number };

/** null when another process holds the lock. */
export async function runRetention(now = new Date()): Promise<RetentionCounts | null> {
  // An advisory lock belongs to a connection, so take and release it on the same reserved one.
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn`select pg_try_advisory_lock(${LOCK_KEY}) as locked`;
    if (!locked) return null;
    try {
      const counts = {
        calls: await deleteExpiredCalls(now),
        audioFiles: await sweepAudio(now),
        cacheFolders: await sweepCache(),
      };
      log('info', `retention: ${counts.calls} calls, ${counts.audioFiles} files, ${counts.cacheFolders} cache folders`);
      return counts;
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

async function deleteExpiredCalls(now: Date): Promise<number> {
  const expired = await db
    .select({ id: calls.id })
    .from(calls)
    .innerJoin(projects, eq(projects.id, calls.projectId))
    .where(
      and(
        isNotNull(projects.retentionDays),
        lt(calls.createdAt, dsql`${now.toISOString()}::timestamptz - make_interval(days => ${projects.retentionDays})`)
      )
    );
  let n = 0;
  for (const { id } of expired) if (await deleteCall(id)) n++;
  return n;
}

/** Files under an hour old are skipped, so an upload in progress is not touched. */
async function sweepAudio(now: Date): Promise<number> {
  let n = 0;
  const old = async (p: string) => {
    const info = await fileInfo(p);
    return info !== null && now.getTime() - info.mtimeMs > HOUR;
  };
  for (const name of await list('audio/tmp')) {
    if (await old(`audio/tmp/${name}`)) {
      await remove(`audio/tmp/${name}`);
      n++;
    }
  }
  const names = (await list('audio')).filter((name) => name !== 'tmp');
  const known = new Set<string>();
  const ids = names.filter((name) => UUID.test(name));
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await sql<{ id: string }[]>`select id from app.calls where id = any(${ids.slice(i, i + 500)}::uuid[])`;
    for (const row of rows) known.add(row.id);
  }
  for (const name of names) {
    if (known.has(name.toLowerCase())) continue;
    if (await old(`audio/${name}`)) {
      await remove(`audio/${name}`);
      n++;
    }
  }
  return n;
}

/** `cache/{organizationId}/{sha}/`: kept only while a call of that organisation has that hash. */
async function sweepCache(): Promise<number> {
  let n = 0;
  for (const orgId of await list('cache')) {
    const [org] = UUID.test(orgId)
      ? await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId))
      : [];
    if (!org) {
      await remove(`cache/${orgId}`);
      n++;
      continue;
    }
    const rows = await db
      .selectDistinct({ sha: calls.audioSha256 })
      .from(calls)
      .innerJoin(projects, eq(projects.id, calls.projectId))
      .where(eq(projects.organizationId, orgId));
    const used = new Set(rows.map((row) => row.sha));
    for (const sha of await list(`cache/${orgId}`)) {
      if (!used.has(sha)) {
        await remove(`cache/${orgId}/${sha}`);
        n++;
      }
    }
  }
  return n;
}
