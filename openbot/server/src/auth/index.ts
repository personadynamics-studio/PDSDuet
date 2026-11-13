import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { expo } from "@better-auth/expo";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { genericOAuth, okta } from "better-auth/plugins";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  scimConnectionBindings,
  scimGroupMembers,
  scimGroups,
  scimIdentityTombstones,
  scimProjectionGrants,
  scimSubjects,
  scimUsers,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { seedRole } from "./roles";
import { scimOptions } from "./scim";


/**
 * An address for somebody arriving from Entra, whatever claim it turned up in.
 *
 * Entra does not always send `email`. Microsoft return it only when the profile carries an email
 * attribute, and for a multi-tenant application optional claims may not arrive at all, because an
 * external user's token is minted by their own tenant and does not inherit this application's claim
 * configuration. `common`, the default tenant here, is multi-tenant.
 *
 * Better Auth maps `email` straight through with no fallback, so on those deployments it is
 * undefined. That matters more here than in most products: every authorization decision OpenBot
 * makes about a person is keyed on their address. `INITIAL_ADMIN_EMAILS`, the role
 * and the People screen all read it, so an absent address is not a cosmetic gap. Somebody would
 * sign in successfully, match no administrator, and land as a plain user with nothing on any screen
 * explaining why.
 *
 * `upn` first because it is the directory's own name for the account, then `preferred_username`,
 * which the OIDC spec explicitly does not promise is an address but which Entra populates with the
 * UPN in practice. Returning nothing when neither is present is deliberate: Better Auth then
 * refuses the sign-in, and being refused is a far better answer than being quietly admitted as
 * somebody the deployment cannot recognise.
 */
export function mapEntraProfile(profile: Record<string, unknown>) {
  const claim = (name: string) => {
    const value = profile[name];
    return typeof value === "string" && value.includes("@") ? value : undefined;
  };

  const email = claim("email") ?? claim("upn") ?? claim("preferred_username");
  if (!email) {
    console.error(
      JSON.stringify({
        type: "entra-profile-missing-email",
        note: "Entra returned no email, upn or preferred_username claim, so this person cannot be identified. Add `email` as an optional claim on the app registration, or use a single-tenant MICROSOFT_OAUTH_TENANT_ID.",
        claims: Object.keys(profile),
      }),
    );
    return {};
  }

  return { email };
}

export function createAuth(config: DeploymentConfig, database: Database) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

  /*
   * Okta goes through the generic OAuth plugin, the other two do not.
   *
   * Google and Entra are named providers that Better Auth knows the endpoints of. Okta is not one
   * place: every customer has their own issuer, so it is OIDC discovery against a URL rather than a
   * provider with a fixed address. The plugin is only registered when Okta is configured, so a
   * deployment that does not use it carries no extra routes.
   *
   * They converge again at the browser: `signIn.social({ provider })` starts all three, so the
   * sign-in screen has one code path and does not need to know which kind each provider is.
   */
  const scimDeps = {
    database,
  };
  const scimPluginOptions = scimOptions(scimDeps);

  /*
   * The native app signs in through its custom scheme, and the Expo plugin appends the session cookie
   * to that redirect. Any Android app can register the same scheme, so the scheme is trusted only on
   * a deployment that runs the native app (EXPO_PROJECT_ID, as for push). Elsewhere a sign-in can
   * never be sent there.
   */
  const nativeApp = Boolean(process.env.EXPO_PROJECT_ID?.trim());
  const plugins = [
    ...(nativeApp ? [expo()] : []),
    /*
     * SCIM 2.0 at /api/auth/scim/v2, only when SCIM_BEARER_TOKEN is set. See scim.ts.
     */
    ...(scimPluginOptions ? [scim(scimPluginOptions)] : []),
    ...(authConfig.okta
      ? [
          genericOAuth({
            config: [
              okta({
                clientId: authConfig.okta.clientId,
                clientSecret: authConfig.okta.clientSecret,
                issuer: authConfig.okta.issuer,
              }),
            ],
          }),
        ]
      : []),
    sso(),
  ];

  return betterAuth({
    user: {
      additionalFields: {
        preferences: {
          type: "json",
          required: false,
          // Settings validates and patches this field for both SSO and single-user mode.
          input: false,
        },
        /*
         * Directory groups, written by SCIM's projection (scim.ts) and read by the per-group
         * capability switches and network policies. Never accepted from a sign-in request.
         */
        groups: {
          type: "string[]",
          required: false,
          input: false,
        },
      },
    },
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    /*
     * Wrapped, so a company's client secret is ciphertext in the column.
     *
     * The SSO plugin writes `oidc_config` and `saml_config` as plaintext JSON, and the client secret
     * for a customer's directory is inside them. Every other secret this deployment keeps goes
     * through `KEY_ENCRYPTION_KEY`; these two were the exception. See encrypt-sso-config.ts.
     */
    database: encryptSsoConfig(
      drizzleAdapter(database, {
        provider: "pg",
        usePlural: true,
        schema: {
          users,
          sessions,
          accounts,
          verifications,
          ssoProviders,
          scimConnectionBindings,
          scimIdentityTombstones,
          scimSubjects,
          scimUsers,
          scimProjectionGrants,
          scimGroups,
          scimGroupMembers,
        },
        // The SCIM plugin needs interactive transactions; nothing else here asked for them.
        transaction: Boolean(scimPluginOptions),
      }),
      config.keyEncryptionKey,
    ),
    account: {
      /*
       * The provider's access and refresh tokens, encrypted at rest.
       *
       * Better Auth's own mechanism, which uses `BETTER_AUTH_SECRET` rather than
       * `KEY_ENCRYPTION_KEY`. Deliberately theirs: it encrypts on the way into storage and decrypts
       * on the way out, in the one place that knows every path a token takes, and hand-rolling that
       * inside somebody else's storage layer is how rows become permanently unreadable. It also
       * tolerates the plaintext already in the column, so switching it on does not invalidate the
       * accounts of everybody who has already signed in.
       */
      encryptOAuthTokens: true,
    },
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
      ...(authConfig.microsoft
        ? {
            microsoft: {
              clientId: authConfig.microsoft.clientId,
              clientSecret: authConfig.microsoft.clientSecret,
              tenantId: authConfig.microsoft.tenantId,
              mapProfileToUser: mapEntraProfile,
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await seedRole(database, user.id, user.email, authConfig.initialAdminEmails);
          },
        },
      },
    },
  });
}
