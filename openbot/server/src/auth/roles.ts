import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";

export type OpenBotRole = "admin" | "user";

/**
 * Whether this address is an administrator by configuration.
 *
 * A floor, not the whole answer. Somebody named here is always an administrator and cannot be
 * demoted from the admin screen, which is what makes it the way back in when the last administrator
 * demotes themselves by accident. Everybody else's role is whatever an administrator has set.
 */
export function isConfiguredAdmin(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  );
}

/**
 * Give somebody exactly one role.
 *
 * `user_roles` is a set with a `(user_id, role)` primary key. Setting a role removes the other
 * assignment in the same transaction, so readers see the whole change at once.
 */
export async function setRole(
  database: Database,
  userId: string,
  role: OpenBotRole,
): Promise<OpenBotRole> {
  await database.transaction(async (tx) => {
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), ne(userRoles.role, role)));
    await tx.insert(userRoles).values({ userId, role }).onConflictDoNothing();
  });

  return role;
}

/**
 * The role a brand-new account starts with.
 *
 * The only moment configuration decides somebody who is not on the list: from here on that person's
 * role belongs to whoever administers the deployment.
 */
export async function seedRole(
  database: Database,
  userId: string,
  email: string,
  initialAdminEmails: readonly string[],
): Promise<OpenBotRole> {
  return setRole(
    database,
    userId,
    isConfiguredAdmin(email, initialAdminEmails) ? "admin" : "user",
  );
}

