import type { MiddlewareHandler } from "hono";
import type { OpenBotRole } from "./roles";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: OpenBotRole;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null>;
  };
};

export type AppVariables = {
  actor: AuthenticatedActor;
};

export type ResolveRequestActor = (
  request: Request,
) => Promise<AuthenticatedActor | null>;

export function createRequireUser(
  resolveRequestActor: ResolveRequestActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const actor = await resolveRequestActor(context.req.raw);

    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }

    context.set("actor", actor);
    await next();
  };
}

export function createRequireAdmin(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return (context, next) => requireUser(context, async () => {
    if (context.var.actor.role !== "admin") {
      context.res = context.json({ error: "Administrator access required." }, 403);
      return;
    }
    await next();
  });
}

