// Files under DATA_DIR (item 24). Paths are relative to it: `audio/{callId}`, `audio/tmp/{uuid}` and
// `cache/{organizationId}/{sha}/`. No path that comes from a request reaches these functions: callers
// build them from ids they read from the database.
import 'server-only';

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename as fsRename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { env } from '@/env';

function resolve(relative: string): string {
  const root = path.resolve(env.DATA_DIR);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path outside DATA_DIR');
  return full;
}

/** Writes `source` through `through` to the file. One pipeline, so an error in any stage destroys all. */
export async function putStream(relative: string, source: Readable, through: Transform): Promise<void> {
  const full = resolve(relative);
  await mkdir(path.dirname(full), { recursive: true });
  await pipeline(source, through, createWriteStream(full, { mode: 0o600 }));
}

export async function rename(from: string, to: string): Promise<void> {
  const target = resolve(to);
  await mkdir(path.dirname(target), { recursive: true });
  await fsRename(resolve(from), target);
}

export async function exists(relative: string): Promise<boolean> {
  return (await fileInfo(relative)) !== null;
}

/** Size and age of a file or folder, or null when it is missing. */
export async function fileInfo(
  relative: string
): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
  try {
    const s = await stat(resolve(relative));
    return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** `range` is inclusive on both ends, like an HTTP Range header. */
export function getStream(relative: string, range?: { start: number; end: number }): Readable {
  return createReadStream(resolve(relative), range);
}

/** Names directly under `prefix`; empty when the folder is missing. */
export async function list(prefix: string): Promise<string[]> {
  try {
    return await readdir(resolve(prefix));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Recursive; no error when the path is missing. */
export async function remove(relative: string): Promise<void> {
  const full = resolve(relative);
  if (full === path.resolve(env.DATA_DIR)) throw new Error('refusing to remove DATA_DIR');
  await rm(full, { recursive: true, force: true });
}

export const audioPath = (callId: string) => `audio/${callId}`;
