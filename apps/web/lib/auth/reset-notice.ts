// Item 30: the one-time "your password was reset" notice. Server-only (not a server action), so
// it is reachable only from the signed-in layout, for the signed-in user.
import 'server-only';

import { and, eq, isNotNull } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';

/** The reset notice (item 30): returned once, then cleared. */
export async function takePasswordResetNotice(userId: string): Promise<{ at: string; by: string | null } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ at: userTable.passwordResetAt, by: userTable.passwordResetBy })
      .from(userTable)
      .where(and(eq(userTable.id, userId), isNotNull(userTable.passwordResetAt)))
      .for('update');
    if (!row?.at) return null;
    let byName: string | null = null;
    if (row.by) {
      const [actor] = await tx.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, row.by));
      byName = actor?.name ?? null;
    }
    await tx.update(userTable).set({ passwordResetAt: null, passwordResetBy: null }).where(eq(userTable.id, userId));
    return { at: row.at.toISOString(), by: byName };
  });
}
