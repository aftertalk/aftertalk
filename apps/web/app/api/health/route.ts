import { sql } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

// Compose health check: 200 when the database answers.
export async function GET() {
  try {
    await sql`select 1`;
    return Response.json({ status: 'ok' });
  } catch {
    return Response.json({ status: 'database unavailable' }, { status: 503 });
  }
}
