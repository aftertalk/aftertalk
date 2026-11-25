// Storing an uploaded recording (item 32, "Upload and search"). The body is streamed to a temporary
// file while it is counted and hashed, checked by extension and first bytes, and then, in one
// transaction, the call and its first job are inserted and the file moves to audio/{callId}.
import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import { db } from '@/lib/db/client';
import { calls, jobs } from '@/lib/db/schema/app';
import { log } from '@/lib/log';
import { audioPath, putStream, remove, rename } from '@/lib/storage';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_CHANNEL_LABEL = 40;

/** Extension → stored content type. The six formats the engine decodes. */
export const UPLOAD_FORMATS: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

export type UploadRefusal = 'too_large' | 'empty' | 'bad_format' | 'bad_filename' | 'bad_channels' | 'incomplete';

export class UploadError extends Error {
  constructor(
    public readonly reason: UploadRefusal,
    public readonly status: number
  ) {
    super(reason);
    this.name = 'UploadError';
  }
}

/** The file name without any folder part or control characters; null when nothing usable is left. */
export function cleanFilename(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';

  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || name.length > 255 || name === '.' || name === '..') return null;
  return name;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/** Both labels or neither; each 1 to 40 characters after trimming; different from each other. */
export function cleanChannelRoles(
  channel0: string | null,
  channel1: string | null
): { channel_0: string; channel_1: string } | null {
  const a = (channel0 ?? '').trim();
  const b = (channel1 ?? '').trim();
  if (a === '' && b === '') return null;
  const ok = (label: string) => label.length >= 1 && label.length <= MAX_CHANNEL_LABEL;
  if (!ok(a) || !ok(b) || a.toLowerCase() === b.toLowerCase()) throw new UploadError('bad_channels', 400);
  return { channel_0: a, channel_1: b };
}

/** Do the first bytes look like the format the extension claims? */
export function matchesFormat(extension: string, head: Buffer): boolean {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString('latin1');
  switch (extension) {
    case '.wav':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
    case '.mp3':
      // An ID3 tag, or an MPEG audio frame sync.
      return ascii(0, 3) === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case '.m4a':
      return ascii(4, 8) === 'ftyp';
    case '.ogg':
      return ascii(0, 4) === 'OggS';
    case '.flac':
      return ascii(0, 4) === 'fLaC';
    case '.webm':
      return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
    default:
      return false;
  }
}

export type StoreUploadInput = {
  projectId: string;
  userId: string;
  filename: string;
  channelRoles: { channel_0: string; channel_1: string } | null;
  body: ReadableStream<Uint8Array>;
  /** The Content-Length header, when the browser sent one. */
  declaredBytes: number | null;
};

export async function storeUpload(input: StoreUploadInput): Promise<{ callId: string }> {
  const extension = extensionOf(input.filename);
  const contentType = UPLOAD_FORMATS[extension];
  if (!contentType) throw new UploadError('bad_format', 415);
  if (input.declaredBytes !== null && input.declaredBytes > MAX_UPLOAD_BYTES) throw new UploadError('too_large', 413);

  const tmp = `audio/tmp/${randomUUID()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) return done(new UploadError('too_large', 413));
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      hash.update(chunk);
      done(null, chunk);
    },
  });

  try {
    const source = Readable.fromWeb(input.body as Parameters<typeof Readable.fromWeb>[0]);
    await putStream(tmp, source, meter);
    if (bytes === 0) throw new UploadError('empty', 400);
    // A body cut short on the way (a proxy limit, a dropped connection) must not become a call.
    if (input.declaredBytes !== null && input.declaredBytes !== bytes) throw new UploadError('incomplete', 400);
    if (!matchesFormat(extension, head)) throw new UploadError('bad_format', 415);

    const callId = await db.transaction(async (tx) => {
      const [call] = await tx
        .insert(calls)
        .values({
          projectId: input.projectId,
          uploadedBy: input.userId,
          originalFilename: input.filename,
          contentType,
          sizeBytes: bytes,
          audioSha256: hash.digest('hex'),
          channelRoles: input.channelRoles,
        })
        .returning({ id: calls.id });
      await tx.insert(jobs).values({ callId: call.id, attempt: 1, status: 'queued' });
      // Inside the transaction: if the move fails nothing is committed. If the commit fails after
      // the move, the file has no call and the hourly sweep removes it.
      await rename(tmp, audioPath(call.id));
      return call.id;
    });
    log('info', 'call uploaded', { call_id: callId, project_id: input.projectId, user_id: input.userId });
    return { callId };
  } catch (e) {
    await remove(tmp).catch(() => {});
    if (e instanceof UploadError) throw e;
    // The browser went away mid-upload, or the stream broke.
    if ((e as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE' || (e as Error)?.name === 'AbortError') {
      throw new UploadError('incomplete', 400);
    }
    throw e;
  }
}
