'use server';

import { sql } from 'drizzle-orm';

import { ACTION_ITEM_COLUMNS, ACTION_ITEM_JOINS, type ActionItemRow, toActionItem } from '@/lib/calls/queries';
import { db } from '@/lib/db/client';
import type { ActionItems } from '@/lib/types';
import type { DateRangeInput } from '@/lib/utils/date-range';

import { dashboardScope } from './range';

/** The newest open tasks from calls in the range. */
export async function getDashboardActionItems(
  projectId: string,
  input?: DateRangeInput,
  limit: number = 5
): Promise<ActionItems> {
  const { from, to } = await dashboardScope(projectId, input);
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5;
  const where = sql`ai.project_id = ${projectId} and ai.status = 'PENDING'
    and c.created_at >= ${from} and c.created_at <= ${to}`;
  const [rows, [count]] = await Promise.all([
    db.execute<ActionItemRow>(sql`
      select ${ACTION_ITEM_COLUMNS} ${ACTION_ITEM_JOINS}
      where ${where} order by c.created_at desc, ai.item_index limit ${size}`),
    db.execute<{ n: number }>(
      sql`select count(*)::int as n from app.action_items ai join app.calls c on c.id = ai.call_id where ${where}`
    ),
  ]);
  return {
    items: rows.map(toActionItem).map((item) => ({
      id: item.id,
      callId: item.transcriptId,
      callDate: item.callDate,
      callFilename: item.callFilename,
      description: item.description,
      responsibleParty: item.responsibleParty,
      deadlineMentioned: item.deadlineMentioned,
      quote: item.quote,
      isOverdue: item.isOverdue,
    })),
    totalPending: count.n,
  };
}
