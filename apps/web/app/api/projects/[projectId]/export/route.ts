// GET /api/projects/{projectId}/export (item 37): the calls matching the filters of the calls list,
// as one JSON document, streamed one call at a time. Project editors and above.
import { eq } from 'drizzle-orm';

import { accessErrorResponse, requireProjectAccess } from '@/lib/access';
import { type CallListFilter, listCallIds } from '@/lib/calls/queries';
import { db } from '@/lib/db/client';
import { projects } from '@/lib/db/schema/app';
import { exportCall } from '@/lib/export';
import { log } from '@/lib/log';
import { userTimeZone, zonedRange } from '@/lib/time-zone';
import { callsDateRangeInput } from '@/lib/utils/date-range';
import { isUuid } from '@/lib/utils/uuid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    if (!isUuid(projectId)) return Response.json({ error: 'Not found' }, { status: 404 });
    const { user } = await requireProjectAccess(projectId, 'EDITOR');

    // The same query string as the calls list: range, from, to, q.
    const query = new URL(request.url).searchParams;
    // Parsed exactly as the list parses it, so the file holds the calls the list shows.
    const input = callsDateRangeInput({
      range: query.get('range') ?? undefined,
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
    });
    const filter: CallListFilter = input.preset === 'allTime' ? {} : zonedRange(input, await userTimeZone(user.id));
    const q = query.get('q')?.trim().slice(0, 200);
    if (q) filter.q = q;

    const [[project], ids] = await Promise.all([
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, projectId)),
      listCallIds(projectId, filter),
    ]);
    log('info', `export of ${ids.length} calls`, { project_id: projectId, user_id: user.id });

    const encoder = new TextEncoder();
    let next = 0;
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const head = { exported_at: new Date().toISOString(), project };
        controller.enqueue(encoder.encode(`${JSON.stringify(head).slice(0, -1)},"calls":[`));
      },
      // One call per pull, so a slow reader holds back the queries instead of filling memory.
      async pull(controller) {
        try {
          while (next < ids.length) {
            const call = await exportCall(projectId, ids[next++]);
            if (!call) continue;
            controller.enqueue(encoder.encode((first ? '' : ',') + JSON.stringify(call)));
            first = false;
            return;
          }
          controller.enqueue(encoder.encode(']}'));
          controller.close();
        } catch (e) {
          // The 200 is already sent, so the download must fail visibly, not end as a cut-off file
          // that looks complete: erroring the stream aborts the response mid-body.
          log('error', 'export failed part way', { project_id: projectId, user_id: user.id });
          controller.error(e);
        }
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="aftertalk-export-${day}.json"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    const response = accessErrorResponse(e);
    if (response) return response;
    throw e;
  }
}
