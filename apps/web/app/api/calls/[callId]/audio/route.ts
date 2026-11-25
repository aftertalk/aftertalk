// GET /api/calls/{callId}/audio (item 37a): the original recording, with HTTP range support so the
// player can seek. Organisation owners and admins always; an organisation member when the project's
// member_pii_access is `full`, otherwise 403. A call with no stored result answers 404 for everyone.
// Every request writes a pii_access_log row, unless the same user already has one for this call in
// the last hour. The browser never gets a file path.
import { Readable } from 'node:stream';

import { and, eq, gt } from 'drizzle-orm';

import { accessErrorResponse, requireProjectAccess, requireUser } from '@/lib/access';
import { mayUsePersonalData } from '@/lib/calls/personal-data';
import { db } from '@/lib/db/client';
import { calls, piiAccessLog } from '@/lib/db/schema/app';
import { parseRange } from '@/lib/http-range';
import { log } from '@/lib/log';
import { audioPath, fileInfo, getStream } from '@/lib/storage';
import { isUuid } from '@/lib/utils/uuid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HOUR = 60 * 60 * 1000;
const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ callId: string }> }) {
  try {
    const { callId } = await params;
    if (!isUuid(callId)) return notFound();
    const user = await requireUser();
    const [call] = await db
      .select({ projectId: calls.projectId, status: calls.status, contentType: calls.contentType })
      .from(calls)
      .where(eq(calls.id, callId));
    if (!call) return notFound();
    const { orgRole } = await requireProjectAccess(call.projectId, 'VIEWER', user);
    if (!(await mayUsePersonalData(call.projectId, orgRole))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (call.status === 'pending') return notFound();
    const info = await fileInfo(audioPath(callId));
    if (!info || info.isDirectory) return notFound();

    const range = parseRange(request.headers.get('range'), info.size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    }

    const [recent] = await db
      .select({ id: piiAccessLog.id })
      .from(piiAccessLog)
      .where(
        and(
          eq(piiAccessLog.callId, callId),
          eq(piiAccessLog.userId, user.id),
          eq(piiAccessLog.kind, 'audio'),
          gt(piiAccessLog.createdAt, new Date(Date.now() - HOUR))
        )
      )
      .limit(1);
    if (!recent) {
      await db.insert(piiAccessLog).values({ callId, userId: user.id, kind: 'audio' });
      log('info', 'audio played', { call_id: callId, user_id: user.id });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    const headers: Record<string, string> = {
      'Content-Type': call.contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      // Played in the page, never opened as a document.
      'Content-Disposition': 'inline',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    const body = Readable.toWeb(getStream(audioPath(callId), { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (e) {
    const response = accessErrorResponse(e);
    if (response) return response;
    throw e;
  }
}
