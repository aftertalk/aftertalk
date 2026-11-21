// How long a password reset link works. scripts/reset-owner.ts writes the reset row in the shape
// Better Auth's /reset-password reads ("reset-password:<token>", value = user id).
export const RESET_LINK_TTL_SECONDS = 60 * 60;
