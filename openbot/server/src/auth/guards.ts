import type { MiddlewareHandler } from "hono";
import { roleForEmail, type OpenBotRole } from "./roles";

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

export function createRequireUser(
  auth: AuthService,
  initialAdminEmails: readonly string[],
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    const role = roleForEmail(session.user.email, initialAdminEmails);

    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
    });
    await next();
  };
}

