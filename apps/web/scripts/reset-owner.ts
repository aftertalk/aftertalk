// Operator recovery (#73, item 30): for when nobody above a user can help, usually the only owner.
// Run inside the web container:
//   docker compose exec web node reset-owner.js [--email someone@example.com] [--reset-2fa]
// Without --email it picks the first owner of the oldest organisation. Prints a one-hour password
// reset link, ends the user's sessions and, with --reset-2fa, turns their 2FA off.
// Plain SQL on purpose: bundled with esbuild into dist/reset-owner.js, it runs without Next or
// Better Auth. The reset row matches what Better Auth's requestPasswordReset writes, so the normal
// /reset-password page accepts the link.
import { randomBytes, randomUUID } from 'node:crypto';

import postgres from 'postgres';

const RESET_LINK_TTL_SECONDS = 60 * 60; // same as lib/auth/auth.ts
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Better Auth's token shape: 24 alphanumeric characters. */
function newToken(length = 24): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += ALPHANUMERIC[b % 62];
    }
  }
  return out;
}

export function parseArgs(argv: string[]): { email: string | null; reset2fa: boolean } {
  let email: string | null = null;
  let reset2fa = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reset-2fa') reset2fa = true;
    else if (a === '--email') email = (argv[++i] ?? '').trim().toLowerCase() || null;
    else if (a.startsWith('--email=')) email = a.slice('--email='.length).trim().toLowerCase() || null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { email, reset2fa };
}

export async function resetOwner(
  databaseUrl: string,
  publicUrl: string,
  opts: { email: string | null; reset2fa: boolean }
): Promise<{ email: string; link: string }> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const [target] = opts.email
        ? await tx<{ id: string; email: string }[]>`select id, email from auth."user" where email = ${opts.email}`
        : await tx<{ id: string; email: string }[]>`
            select u.id, u.email
            from app.organization_members m
            join app.organizations o on o.id = m.organization_id
            join auth."user" u on u.id = m.user_id
            where m.role = 'OWNER'
            order by o.created_at, m.joined_at
            limit 1`;
      if (!target) throw new Error(opts.email ? 'No user with that email' : 'No organization owner found');

      const token = newToken();
      await tx`
        insert into auth.verification (id, identifier, value, expires_at)
        values (${randomUUID()}, ${`reset-password:${token}`}, ${target.id},
                now() + make_interval(secs => ${RESET_LINK_TTL_SECONDS}))`;
      await tx`delete from auth.session where user_id = ${target.id}`;
      // passwordResetBy stays null: the notice then names "an admin".
      await tx`update auth."user" set password_reset_at = now(), password_reset_by = null where id = ${target.id}`;
      if (opts.reset2fa) {
        await tx`delete from auth.two_factor where user_id = ${target.id}`;
        await tx`update auth."user" set two_factor_enabled = false where id = ${target.id}`;
      }
      const link = new URL(`/reset-password?token=${token}`, publicUrl).toString();
      return { email: target.email, link };
    });
  } finally {
    await sql.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const publicUrl = process.env.PUBLIC_URL;
  if (!databaseUrl || !publicUrl) throw new Error('DATABASE_URL and PUBLIC_URL must be set');
  const opts = parseArgs(process.argv.slice(2));
  const { email, link } = await resetOwner(databaseUrl, publicUrl, opts);
  // The operator needs the link on the terminal; it is not written to the application log.
  process.stdout.write(
    `Password reset link for ${email} (valid for one hour, works once):\n${link}\n` +
      (opts.reset2fa ? 'Two-factor authentication is now off for this user.\n' : '')
  );
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`reset-owner failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
