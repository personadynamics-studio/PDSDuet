import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AuthenticatedActor } from "./guards";



export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin",
};

type UserWriter = Pick<Database, "insert">;

export async function initializeDevActorUser(
  database: UserWriter,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  await database
    .insert(users)
    .values({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name,
      emailVerified: false,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: DEV_ACTOR.email,
        name,
        updatedAt: new Date(),
      },
    });

  return true;
}


