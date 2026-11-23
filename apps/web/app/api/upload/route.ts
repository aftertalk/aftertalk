// POST /api/upload (item 32): one recording per request. The body is the file itself, streamed to
// disk; the file name, project and channel labels travel in headers. A multipart form would have to
// be parsed in memory (Request.formData() buffers the whole body), which a 500 MB file rules out.
// This path is outside the proxy matcher (the proxy would buffer and cut the body), so the session
// is checked here.
import { getTranslations } from 'next-intl/server';

import { env } from '@/env';
import { i18n } from '@/i18n/constants';
import { accessErrorResponse, requireProjectAccess, requireUser } from '@/lib/access';
import { projectReadiness } from '@/lib/project-readiness';
import { cleanChannelRoles, cleanFilename, storeUpload, UploadError, type UploadRefusal } from '@/lib/upload';
import { isUuid } from '@/lib/utils/uuid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MESSAGE: Record<UploadRefusal, string> = {
  too_large: i18n.upload.errors.tooLarge,
  empty: i18n.upload.errors.empty,
  bad_format: i18n.upload.errors.badFormat,
  bad_filename: i18n.upload.errors.badFilename,
  bad_channels: i18n.upload.errors.badChannels,
  incomplete: i18n.upload.errors.incomplete,
};

/** Header values are percent-encoded by the browser code, so any file name survives the trip. */
function header(request: Request, name: string): string | null {
  const raw = request.headers.get(name);
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const refuse = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const t = await getTranslations();
  try {
    // A custom header cannot be set by a cross-site form, and a cross-site script would need CORS,
    // which this route never grants. The origin check is the second lock.
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(env.PUBLIC_URL).origin) return refuse(403, 'Forbidden');
    const projectId = request.headers.get('x-aftertalk-project');
    if (!projectId || !isUuid(projectId)) return refuse(404, 'Not found');

    const user = await requireUser();
    await requireProjectAccess(projectId, 'EDITOR', user);
    if (!(await projectReadiness(projectId)).canUpload) return refuse(409, t(i18n.upload.errors.notReady));

    const filename = cleanFilename(header(request, 'x-aftertalk-filename') ?? '');
    if (!filename) throw new UploadError('bad_filename', 400);
    const channelRoles = cleanChannelRoles(
      header(request, 'x-aftertalk-channel-0'),
      header(request, 'x-aftertalk-channel-1')
    );
    if (!request.body) throw new UploadError('empty', 400);
    const length = request.headers.get('content-length');
    const declaredBytes = length !== null && /^\d+$/.test(length) ? Number(length) : null;

    const { callId } = await storeUpload({
      projectId,
      userId: user.id,
      filename,
      channelRoles,
      body: request.body,
      declaredBytes,
    });
    // Phase 3 runs a queue tick here, after the commit.
    return Response.json({ callId }, { status: 201 });
  } catch (e) {
    if (e instanceof UploadError) return refuse(e.status, t(MESSAGE[e.reason]));
    const response = accessErrorResponse(e);
    if (response) return response;
    throw e;
  }
}
