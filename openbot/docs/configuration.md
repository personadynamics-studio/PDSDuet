# Configuration

The active Browser/Bot core is configured with environment variables and a tenant package. Manual mail/calendar connectors remain; retired background scheduling, enterprise controls, authoring playgrounds and telemetry exporters are not configured by this core.

## Environment setup

```sh
cp .env.example .env
```

Fill the required values, then run:

```sh
bash scripts/start.sh
```

## Required API server variables

| Variable                      | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string.                                                                         |
| `KEY_ENCRYPTION_KEY`          | Base64-encoded 32-byte key for encrypted stored credentials. Generate with `openssl rand -base64 32`. |

The default `examples/openduet/agents.yaml` declares the insurance PDF Bot at
`http://localhost:4201/ag-ui` and a built-in search Bot. The local start script starts the LangGraph
service for that endpoint. A deployment using another address should declare it in its own tenant
package; built-in Bots do not need a remote endpoint.

## General variables

The left menu lists the current person's available Bots. Their explicit selection is used by Chat
and Make. If no Bot is selected or available, Chat opens the selection and creation dialog.
There is no environment, tenant, harness or first-row fallback, and opening Chat starts no model work.

| Variable             | Default                            | Meaning                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `PORT`               | `3001`                             | API server port. `SERVER_PORT` names the same port; set either, or both to the same value, or the server refuses to start. |
| `OPENBOT_HOST`       | this machine with no sign-in; every interface with sign-in | Where the API server and the app's dev, preview and installed servers listen. A comma-separated list of addresses; `0.0.0.0`, `::` or `*` is every interface. See [Where it listens](#where-it-listens). |
| `NODE_ENV`           | unset                              | `production` refuses the example `KEY_ENCRYPTION_KEY`. Sign-in is enabled by the configured identity providers. |
| `TENANT_PACKAGE_DIR` | `../examples/openduet`             | Tenant package directory, resolved from `server/`; an absolute path is also accepted. |
| `DEPLOYMENT_ID`      | the tenant package's id            | Names this local deployment and prefixes the identity a Shared app's account is held under at the vendor. That identity is fixed when the app is made Shared, so changing this later does not move it. |
| `OPENAI_API_KEY`     | unset                              | Default model key for built-in agents and both shipped Bots.        |
| `OPENAI_BASE_URL`    | unset                              | OpenAI-compatible endpoint that key is spent against. See below.    |
| `BOT_PROVIDER`       | `openai`                           | Provider for the retained TypeScript LangGraph backend: `openai`, `anthropic`, or `google`. |
| `ANTHROPIC_API_KEY`  | unset                              | Anthropic key when `BOT_PROVIDER=anthropic`.                        |
| `ANTHROPIC_BASE_URL` | unset                              | Anthropic-compatible endpoint that key is spent against.            |
| `GOOGLE_API_KEY`     | unset                              | Google key when `BOT_PROVIDER=google`.                              |
| `GOOGLE_GENERATIVE_AI_BASE_URL` | unset                   | Google-compatible endpoint that key is spent against.               |
| `BOT_MODEL`          | the Bot's row in the spec file   | Model for whichever Bot is starting. Unset, it comes from that Bot's row in [the provider spec file](#the-provider-spec-file); the provider fallbacks are `gpt-5.5`, `claude-sonnet-4-5`, and `gemini-2.5-flash`. |
| `BOT_RESPONSES_API`  | `false`                            | Makes `agent-langgraph` use the OpenAI Responses API.               |
| `BOT_REASONING_EFFORT` | unset (provider default)         | OpenAI and the Responses API only: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `agent-langgraph` refuses to start on any other value, on a non-`openai` provider, or without the Responses API. |
| `AGENT_TOOL_TOKEN`   | unset                              | The secret a framework Bot presents when it calls a granted tool back through this server. |
| `APP_DIST_DIR`       | unset                              | Where the built app is, when this process serves it. Set inside the container image; unset in development, where Vite serves the app. |
| `COMPOSIO_API_KEY`   | unset                              | One key for the whole deployment, for the broker that holds people's accounts for a few hundred apps. Unset, there is nothing to connect, nothing to grant and no Composio tool for a Bot to call; what remains is one row that goes nowhere, under **More apps** on the admin Plugins page, naming this variable. See [Composio](plugins/composio.md). |

**`AGENT_TOOL_TOKEN`** exists because a framework Bot runs its own loop in its own process and still
may not reach a vendor directly. It calls the deployment that granted the tool, which is where the
grant, the policy and the audit row live. Absent, no Bot may call tools back, and it is told so
rather than quietly allowed.

Configure this token on both the API and any external framework Bot that needs those callbacks.
It authenticates the Bot to the API; a remote Bot's own endpoint credential is configured separately
on its profile and stored in the credential vault.

**`SERVER_INTERNAL_URL`** is the API address used by the frontend server to proxy requests. Set it to the API's reachable address when the frontend and API are served separately; it is not a background-worker setting.

## The provider spec file

`shared/model-providers.json` supplies provider facts and Bot defaults to the retained TypeScript
LangGraph backend through `shared/model-providers.ts`. It has two sections: provider configuration,
and the provider and model each registered backend runs:

```json
{
  "providers": {
    "openai": {
      "label": "OpenAI",
      "key_variable": "OPENAI_API_KEY",
      "base_url_variable": "OPENAI_BASE_URL",
      "default_model": "gpt-5.5"
    }
  },
  "bots": {
    "agent-langgraph": { "provider": "openai", "model": "gpt-5.5" }
  }
}
```

The lookup order for `BOT_PROVIDER` and `BOT_MODEL` is unchanged, and the file sits in the middle
of it:

1. the environment — how a deployment overrides what the repository decided;
2. the Bot's row in this file — what the repository decided;
3. the provider's `default_model` — what is left when neither says.

Editing a backend's row changes its default without changing another backend's choice.

A blank value is read as unset, which is what a compose file passing `${BOT_MODEL:-}` hands a Bot
when nobody chose a model. API keys never appear in the file: they arrive in the environment
under the `key_variable` the provider row names.

The TypeScript loader requires each Bot row to name a known provider and nonempty fields. Adding a
provider requires its `providers` row and an entry in `PROVIDER_IDS` in
`shared/model-providers.ts`; the backend must implement that provider as well.

## OpenAI-compatible endpoints

`OPENAI_BASE_URL` decides where an OpenAI-shaped request is answered. Unset, that is OpenAI. Set, it is any endpoint speaking the same API: a gateway in front of several providers, a proxy, or a model on hardware you control.

It applies to Native Bots in the API and to `agent-langgraph` when `BOT_PROVIDER=openai`.

`OPENAI_CONTAINER_BASE_URL` overrides that value inside the Bot containers only, for an endpoint the containers reach by a different route than the host does. Unset, the containers use `OPENAI_BASE_URL` like everything else.

The other two providers work the same way under their own names, because they are different APIs rather than different URLs for this one: `ANTHROPIC_BASE_URL` and `GOOGLE_GENERATIVE_AI_BASE_URL`. All three are the names the API server already reads, so one line moves the built-in agents and the Bots together and a deployment cannot end up with half of itself pointed somewhere else.

Model names travel verbatim, so use whatever the endpoint publishes. An endpoint that namespaces its catalogue wants both halves of the name, in `BOT_MODEL` and in the tenant package's `default_model` alike.

A gateway that fronts several providers behind one key is addressed the usual way:

```sh
OPENAI_BASE_URL=https://gateway.internal/v1
OPENAI_API_KEY=...
BOT_MODEL=openai/gpt-5.6-terra
```

and in the tenant package, where the name is namespaced the same way:

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: openai/gpt-5.6-terra
```

Most gateways publish a model list, which is the way to check a name before configuring it.

Two things are worth knowing before pointing a deployment at any gateway. Not every catalogue entry accepts tools, and a Bot without tool calling cannot drive its computer; the model list says which do. And `BOT_RESPONSES_API=true` needs an endpoint that implements the Responses API, not only chat completions.

## Voice dictation

Dictation inserts recorded speech into the composer for review before sending. It works with any
agent because the agent receives an ordinary text message. Audio configuration is independent of
the chat model provider; neither `OPENAI_BASE_URL` nor `OPENAI_API_KEY` is inherited.

| Variable | Meaning |
| --- | --- |
| `TRANSCRIPTION_PROVIDER` | `openai-compatible`, the first transcription adapter. Unset with all other transcription variables unset disables dictation. |
| `TRANSCRIPTION_BASE_URL` | Explicit API base URL, including the version path if required. The adapter appends `/audio/transcriptions`. |
| `TRANSCRIPTION_MODEL` | Required model name, passed verbatim to the configured service. |
| `TRANSCRIPTION_API_KEY` | Dedicated server-side bearer credential. Optional for services that intentionally require no authentication. |

For OpenAI, set the base URL to `https://api.openai.com/v1` and select an available transcription
model such as `gpt-transcribe`. A compatible local endpoint can instead use
`http://127.0.0.1:8000/v1` and its own model name. Compatibility with chat completions alone does
not imply transcription support. See the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text).

The composer shows the microphone when the service is configured. Browser microphone access needs
HTTPS or localhost. While recording, a live waveform replaces the editor and normal controls.
Press **Stop** to transcribe into the draft, **Send** to transcribe and submit, or **Cancel** to
discard the recording. **Retry** retries a failed transcription with the same selected action.
Text is appended to the current draft, preserving edits, mentions, and files. A failed send restores
the combined draft through the normal message flow. The waveform shares the recorder's microphone
stream and does not use an ElevenLabs service or credential.

The browser stops recording at two minutes. Uploads are limited to 10 MiB, and provider requests
time out after 60 seconds. There is at most one active transcription per user and eight per server
process. These are concurrency limits, not a distributed usage quota; deployments requiring spend
quotas should also enforce them at their audio gateway. Provider failures never switch to another
service. OpenBot keeps audio in memory only, retaining a failed recording in the browser for retry
until cancellation or navigation. Your configured provider's retention policy still applies.

Dictation is separate from live voice calls and does not enable them automatically.

## Live voice calls

The waveform button in an existing channel opens a floating call widget. The realtime voice model
handles conversation, advice, and brainstorming directly, using the selected agent's identity.
Requests needing tools, connected accounts, current facts, or specialist work are delegated to that
channel's existing agent. Delegated requests, agent replies, tools, and generated interfaces use the
normal AG-UI thread. The voice model speaks the returned result and continues the conversation.
Joining includes recent thread messages and previous voice chats, capped at 12,000 characters.

Ending a nonempty call saves its text transcript to the database and creates a compact, expandable
Voice chat card in the same channel. A separate summary request uses the deployment's default chat
model and its existing credential: OpenAI-compatible or Anthropic API keys, Claude or ChatGPT plan
sign-in, or the deployment's Google/xAI OAuth proxy. It does not need a separate OpenAI key when
another provider is selected. Plan summaries use an isolated conversation with no tools. A failed
summary leaves the saved transcript available with a retry button. A successful retry updates the
sidebar preview only while that call is still the latest activity. Interrupted answers are marked
as interrupted rather than treated as fully heard.
Later voice calls and typed agent requests receive the saved voice context. Voice cards are stored
separately from AG-UI messages; ordinary voice conversation does not trigger an agent run.

The browser temporarily keeps unconfirmed transcripts in a local outbox scoped to the signed-in
user, so a failed save or closing the tab can be recovered on returning to the channel. Confirmed
saves are removed from that outbox. No call audio is recorded by OpenBot.

| Variable | Meaning |
| --- | --- |
| `VOICE_PROVIDER` | `openai-realtime` or `xai-realtime`. All voice variables unset disables calls. |
| `VOICE_MODEL` | Required realtime voice model available to your provider account. |
| `VOICE_API_KEY` | Required server credential. Set explicitly; no chat or dictation credential is inherited. Bun `.env` files can explicitly reference `$OPENAI_API_KEY` or `$XAI_API_KEY`. |
| `VOICE_NAME` | Provider voice name; defaults to `marin` for OpenAI or `ara` for Grok. |

OpenAI uses WebRTC, with an authenticated OpenBot endpoint exchanging the browser's SDP offer
using server-owned session configuration. Grok uses WebSocket PCM audio at 24 kHz; OpenBot mints
a short-lived client credential and returns the configured session. Permanent keys stay on the
server. Microphone audio travels directly between the browser and the chosen voice provider.
These are separate transports behind one call interface; an OpenAI-compatible transcription API
does not imply realtime voice support.

Calls require HTTPS or localhost, microphone permission, and browser audio playback. You can mute,
minimize, or end the call. Joining is silent: the agent waits for you to speak. Mute affects only
your microphone; you can still hear the agent. The compact widget shows both participants, with
optional live captions in call settings. Speaking interrupts audio playback. Agent actions already started
continue until completion or the stop button in chat is pressed; hanging up does not undo work.
A second agent request while the thread is busy is refused with an explanation rather than run
concurrently. Existing typed-message queuing remains available. Switching channels or leaving the
page ends the call, and calls do not automatically reconnect or repeat actions. The browser ends
calls after fifteen minutes; this is a UX limit, not an enforceable provider spending quota.

Configuration enables the voice call button but does not prove provider/model availability. Connection
failures appear in the widget while text chat remains available. The call endpoint verifies channel
membership and limits connection attempts. OpenBot does not record call audio; provider retention
policies apply. See [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) and
[Grok Voice](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech).

## Authentication

A configured provider enables sign-in. With no provider, requests share the existing `DEV_ACTOR`
administrator identity. Listening addresses and public URLs do not change that identity policy.
For shared access, configure a provider.

| Variable                     | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`     | Google OAuth client id.                                                                |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret.                                                            |
| `MICROSOFT_OAUTH_CLIENT_ID`  | Microsoft Entra ID application id.                                                     |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Microsoft Entra ID client secret.                                                   |
| `MICROSOFT_OAUTH_TENANT_ID`  | Directory to admit. `common` by default, which admits personal accounts too; a GUID admits one directory. |
| `OKTA_OAUTH_CLIENT_ID`       | Okta client id.                                                                        |
| `OKTA_OAUTH_CLIENT_SECRET`   | Okta client secret.                                                                    |
| `OKTA_OAUTH_ISSUER`          | Which Okta, for example `https://example.okta.com/oauth2/default`.                     |
| `BETTER_AUTH_SECRET`         | At least 32 characters. Required with any provider.                                    |
| `BETTER_AUTH_URL`            | Public API server base URL, where OAuth callbacks return. Required with any provider.  |
| `TRUSTED_ORIGINS`            | Comma-separated app origins accepted by the API, plus every host in a registered OIDC provider's discovery document. |
| `INITIAL_ADMIN_EMAILS`       | Optional comma-separated protected administrators. Other accounts use their stored roles from People. |
| `OPENBOT_PUBLIC_URL`         | Public address of this API. Defaults to `BETTER_AUTH_URL`.                              |
| `OPENBOT_APP_URL`            | Where the browser app is served. Defaults to the first `TRUSTED_ORIGINS` entry.          |

### PDSDuet Google sign-in

Configure Google sign-in, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. `INITIAL_ADMIN_EMAILS` is
optional and protects any listed addresses as administrators. Use the same HTTPS origin for
`BETTER_AUTH_URL` and `OPENBOT_APP_URL`, and register
`<origin>/api/auth/callback/google` on the Google Web application client. Google
sign-in requests only `openid`, `email` and `profile`; Gmail, Calendar and Drive
connections keep their own credentials and grants.

Use the native public/private Bot roster. A public Bot is available to signed-in
users; a private Bot belongs to its creator and follows the existing owner, admin
and team-sharing rules. Conversations and attachments follow their own membership
rules. Computers are allocated per Bot: people using the same public Bot share its
browser logins and workspace, while separate private Bots have separate computers.
Users share the deployment's backend and model API. Google sign-in opens the app directly;
login and listing Bots do not provision copies or require an onboarding wizard.

Before converting an existing single-user installation, back up PostgreSQL,
credentials, browser profiles and workspaces. Retaining the original administrator's
internal user ID preserves local ownership and local conversation thread
identity. Bind that row to the administrator's verified Google email and role;
Better Auth 1.7 requires the local email to be verified before linking a matching
Google account. Do not disable that requirement globally. Keep existing connector
credentials and grants attached to their original owner.

The local start script persists the selected computer provider URL and both
computer-service credentials. Direct API starts therefore read the same
settings as Compose. Restart existing API processes after changing those settings.

**Some variables belong to the desktop app, not to you.** A desktop installation writes these into
its own deployment's `.env` and owns their values: `OPENBOT_MODEL_OAUTH_FILE`, `CHATGPT_AUTH_FILE`,
and `CLAUDE_CODE_OAUTH_TOKEN`. When a model provider is connected by OAuth rather than by key, the
desktop also points `OPENAI_BASE_URL` at OpenBot's own loopback route and sets `OPENAI_API_KEY` to a
local proxy credential rather than a provider key, so those two do not mean what the table above says
in that mode. A server you configure yourself is unaffected by all of this.

**With no provider, all requests use `DEV_ACTOR` as administrator.** No separate single-user flag
is required. Setting a public URL does not enable sign-in or cause an automatic refusal; configure
an identity provider before sharing access with other people.

**Any one provider turns sign-in on**, and several may be configured at once. Each provider's id and
secret must be set together, Okta additionally needs its issuer, and any of them requires
`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Every incomplete combination is
refused at start-up rather than at somebody's first attempt to sign in.

People is the single effective-role policy. Addresses in `INITIAL_ADMIN_EMAILS` are protected
administrators; other accounts use their stored `user_roles` assignment. The list may be empty.
`seedRole` assigns a new account's initial role once; later sign-ins do not rewrite roles. Role
changes made through People take effect on subsequent requests without requiring another sign-in.

SAML and OpenID Connect providers are not configured here. They are registered while the deployment
runs, under Admin → Identity providers, and routed by email domain.

**Registering an OpenID Connect provider needs its endpoints in `TRUSTED_ORIGINS`.** Better Auth
fetches the discovery document and refuses any endpoint inside it that is not a trusted origin, which
is what stops a registration pointing the deployment at an address of somebody else's choosing. It is
every host in the document and not only the issuer, so a Google issuer also needs
`oauth2.googleapis.com` and `openidconnect.googleapis.com`; a typical Okta tenant serves all of them
from one host and needs only that. A registration refused this way names the host it objected to.

What is registered belongs to the deployment rather than to whoever registered it. Every
administrator sees the same list and can remove any of it, and a provider outlives the person who
added it. The client secret and any SAML signing material are encrypted at rest with
`KEY_ENCRYPTION_KEY`.

The redirect URI to register with each provider is `<BETTER_AUTH_URL>/api/auth/callback/<provider>`,
where `<provider>` is `google`, `microsoft` or `okta`.

`OPENBOT_PUBLIC_URL` and `OPENBOT_APP_URL` matter only for a connector each person connects their own account to, such as Google Drive.

`OPENBOT_PUBLIC_URL` builds the redirect URI the vendor sends somebody back to after they consent, which has to match what an administrator registered with that vendor character for character — so it comes from configuration rather than from the incoming request. Most deployments never set it, because `BETTER_AUTH_URL` is already the same public address. With neither, the Plugins page says the deployment cannot complete a consent flow, and no account can be connected.

`OPENBOT_APP_URL` is where the callback sends the person afterwards. It is a separate setting because the app and the API are separate addresses: locally the app is Vite on `3010` and the API is `3001`, so a relative redirect would land on the API, which serves no pages. A deployment serving both from one origin can leave it unset.

A [Composio](plugins/composio.md) app needs `OPENBOT_APP_URL` and nothing else of the two: the consent lives at the broker, so no redirect URI of ours is registered anywhere, but the address Composio returns somebody to has to be absolute and this is where it comes from. Connecting a brokered account refuses where it resolves to nothing, rather than sending somebody to a consent screen with no way back.

### Where it listens

`OPENBOT_HOST` selects the API and frontend listening addresses. When it is unset, the platform's
normal listener default applies; configuring a provider does not change the bind setting. Set a
loopback address for local-only access, or an appropriate address/list for the deployment.

The container image sets `OPENBOT_HOST=0.0.0.0`; its published host address is controlled separately
by `docker run -p`. Without a provider, every reachable request still uses the same `DEV_ACTOR`
administrator identity. A listening address is not a sign-in setting.

**Only this deployment's own pages may change anything.** Every state-changing `/api` request and
every WebSocket must come from one of this deployment's origins (`OPENBOT_PUBLIC_URL` or
`BETTER_AUTH_URL`, `OPENBOT_APP_URL`, each `TRUSTED_ORIGINS` entry, the loopback addresses of
`APP_PORT` and the server's own port, or the IP address the request came to), or from something that
is not a browser page and so sends no `Origin`. A body must be JSON or an upload. A page opened at a
name none of those lists is refused with 403; add its origin to `TRUSTED_ORIGINS`.

### SCIM provisioning

A directory such as Okta or Entra ID can create, update and remove people through SCIM 2.0 at
`<BETTER_AUTH_URL>/api/auth/scim/v2`. It is off while `SCIM_BEARER_TOKEN` is unset.

| Variable                 | Meaning                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `SCIM_BEARER_TOKEN`      | The token the directory sends as a bearer token. Setting it switches SCIM on.                              |
| `SCIM_BEARER_TOKEN_NEXT` | Optional second token accepted beside the first, so the directory can move to a new one before the old one is removed. |
| `SCIM_CONNECTION_ID`     | The name of the directory connection. Defaults to `directory`.                                             |

A person the directory creates gets the `user` role, or `admin` when their address is in
`INITIAL_ADMIN_EMAILS`, and still signs in through the company's identity provider: SCIM creates no
password. Their directory groups become their OpenBot groups, which per-group capability switches
and network policies read. Deactivating or deleting someone in the directory ends their sessions,
deny-lists the address, retires the connector credentials they granted and their linked accounts
(see Linked accounts), and stops their Bots' computers. Reactivating them lifts a deny-list entry
SCIM wrote, never one an administrator wrote.

## Bot discovery and calls

Bots use the signed-in person's visible profile roster. `list_bots` lists their exact IDs and roles; `message_bot` calls a peer through the same executor and conversation. No pairwise Bot grant, depth cap, fan-out cap, queue or relay worker is required. Real connector grants and shared-account consent remain.

## Slack and Microsoft Teams (OpenTag pairing)

OpenBot reaches people in Slack and Teams through [OpenTag](https://github.com/CopilotKit/OpenTag),
the open-source Channels SDK front. OpenTag calls OpenBot as its AG-UI agent; OpenBot does not hold a
Slack app of its own.

| Variable                        | Meaning                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENTAG_SHARED_SECRET`         | Enables the pairing. At least 32 characters. OpenTag must send `Authorization: Bearer <secret>` (its `AGENT_AUTH_HEADER`), and OpenBot sends the same header on proactive posts. |
| `OPENTAG_URL`                   | OpenTag's base URL, for messages sent when no Slack turn is open (replies after an approval, responsibility progress, questions). Without it those sends fail visibly in the outbox, and Slack triggers are refused because channel membership cannot be checked. |
| `OPENTAG_BOT_ICON_URL_TEMPLATE` | Optional `https` PNG URL with `{seed}` (the Bot's avatar seed) or `{agentId}`, used as the Bot's Slack icon on proactive posts.                                                    |

Point OpenTag's `AGENT_URL` at `<public URL>/api/delivery/webhooks/opentag/agent`. A person links
their Slack or Teams identity from a Bot's page, under **Reaching you**: OpenBot shows a one-time `link <code>` message,
valid for ten minutes, which they send to the OpenTag app. After that, only that person's messages
reach their chosen Bot, in their own OpenBot conversation, with governance, approvals and
audit on every turn. Anyone unlinked is told how to link and nothing runs. Approval requests appear
as OpenTag approval cards (allow once, always allow, cancel) and are decided through the approvals
service as the linked owner; a reply to a Bot's question answers that question.

The former direct Slack settings (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_BOT_TOKEN`,
`SLACK_TEAM_ID`, `SLACK_SIGNING_SECRET`) are refused at start-up; unset them.

SMS through Twilio honours Advanced Opt-Out: `STOP` (and Twilio's other opt-out keywords) marks the
number opted out, later messages show `opted_out` in the delivery history instead of being sent, and
`START` resumes. Twilio sends the confirmation reply itself, so OpenBot does not.

## Linked accounts

OpenBot keeps a record of a person's accounts at outside providers, such as their GitHub account
or their Slack user. Each provider is a row on `/connections`, beside the apps, listed when the
person has linked it or this deployment can link it. The row opens the provider's own page
(`/connections/github`, `/connections/slack`), whose **Your account** section shows the link with a
**Disconnect** button, or **Connect** where it can be linked. GitHub's page also lists the
repositories whose events can start a responsibility, and links to a Composio GitHub app where one is
enabled, which is then left out of the list so GitHub appears once. Disconnecting removes the link and revokes
OpenBot's stored copy of any token kept with it, and is audited. For GitHub, the grant itself stays
at GitHub until the person revokes it under GitHub, Settings, Applications.

See "Linking Slack and GitHub accounts" below for setting up each provider. An integration proves an
account in one of two ways: by the provider's own sign-in, or by a one-time code that OpenBot issues
to the signed-in person and that they send from their chat account. Whoever sends the code gets that
chat account linked to the person it was issued to, so treat it like a password and do not share it.
It is valid for ten minutes and works once, and issuing a new code for the same provider invalidates
the earlier one. An outside account links to one OpenBot user at most. Linking a new account at a
provider and workspace replaces the person's earlier link there and revokes its token.

Removing a person, whether an administrator does it or a SCIM deactivation does, retires their
links. Their unused link codes are deleted, any token stored with a link is revoked, and each link is
marked as needing reconnection. The links are kept, not deleted, so the outside account still
resolves to the removed person and is refused rather than treated as an unlinked guest. Each retired
link is recorded in the audit trail.

### Linking Slack and GitHub accounts

Slack is offered only where the OpenTag Slack webhook is set up (the pairing above, so
`OPENTAG_SHARED_SECRET` must be set) and the server can redeem identity codes. The person clicks
**Connect** on Slack's page, which shows a message of the form `link <code>`, and sends it to the
OpenBot app in a direct message within ten minutes. A code sent in a channel is refused and stays
valid until it expires. Teams cannot be linked this way.

GitHub uses a GitHub App. Create one under GitHub Settings, Developer settings, GitHub Apps, and set:

- The callback URL to `<public URL>/api/identity/github/callback`, where the public URL is
  `OPENBOT_PUBLIC_URL` or, if that is unset, `BETTER_AUTH_URL`. With neither set, the server
  refuses to start when `GITHUB_APP_CLIENT_ID` is present.
- "Expire user authorization tokens" on. A webhook is not required for linking.
- A client secret, generated on the App's page.

Then set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`; set both or neither. People
then use **Connect** on GitHub's page while signed in to OpenBot in the same browser. The GitHub
user token is stored encrypted with the link.

After GitHub, the browser is sent back to GitHub's page under Connections, at `OPENBOT_APP_URL`, else the first `TRUSTED_ORIGINS` entry,
else the public URL. Set `OPENBOT_APP_URL` when the app and the server are on different origins, as
in local development (app on `3010`, server on `3001`); one origin needs nothing.

Reachability codes and account-link codes look alike, and Reachability's are checked first. A
Reachability `link <code>` binds a conversation for delivery and is not recorded as a linked
account; a `link <code>` from Slack's page under Connections links the Slack user.

## Text messages

A provider is switched on by setting its variables and is off while none of them are set. Setting
some of a provider's variables and not all of them stops the server at start-up with
`Delivery configuration is incomplete:` and the names that are missing.

| Variable                    | Meaning                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERY_PUBLIC_URL`       | The public origin providers call back on, such as a tunnel or an ingress. Twilio signs each request over the URL it was given, so this has to be the address Twilio was configured with. Unset, OpenBot uses `OPENBOT_PUBLIC_URL`, then `BETTER_AUTH_URL`. It must be an `http(s)` URL or the server does not start. |
| `TWILIO_ACCOUNT_SID`        | Twilio account SID. One of the four SMS settings, which are set together.                                                                                                                                                                          |
| `TWILIO_AUTH_TOKEN`         | Twilio auth token. Used to send and to check the signature on every request Twilio makes.                                                                                                                                                         |
| `TWILIO_VERIFY_SERVICE_SID` | The Twilio Verify service that texts the code a person enters under a Bot's **Reaching you** to confirm their number.                                                                                                                            |
| `TWILIO_FROM_NUMBER`        | The Twilio number OpenBot sends from.                                                                                                                                                                                                              |

With SMS on, point the Twilio number's incoming-message webhook at
`<DELIVERY_PUBLIC_URL>/api/delivery/webhooks/sms`. OpenBot passes
`<DELIVERY_PUBLIC_URL>/api/delivery/webhooks/sms/status` to Twilio as the status callback on each
message it sends.

## Inbound email triggers

An email trigger gets its own address, `trigger-<triggerId>@<OPENBOT_INBOUND_EMAIL_DOMAIN>`. Mail
reaches OpenBot through Amazon SES receiving: a receipt rule for the whole domain publishes to an
SNS topic, and that topic has an HTTPS subscription to `<public URL>/api/events/email/sns`. OpenBot
checks each SNS message's AWS signature and refuses any topic not listed, because a valid signature
proves AWS sent the message, not that the topic is yours. It confirms the subscription itself when
SNS asks.

| Variable                               | Meaning                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `OPENBOT_INBOUND_EMAIL_DOMAIN`         | The domain the receipt rule covers, such as `in.example.com`.                                 |
| `OPENBOT_INBOUND_EMAIL_SNS_TOPIC_ARNS` | Comma-separated ARNs of the SNS topics allowed to deliver mail.                               |

Both are needed. With either missing, the email route is not mounted, and an email trigger has no
address: its page and the Bot both say inbound email is not configured on this deployment.

## Computer and supervisor

| Variable                             | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AGENT_COMPUTER_URL`                 | Shared computer URL. If absent, computer routes are not mounted.                          |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.     |
| `COMPUTER_BROWSER_BACKEND`           | `managed` by default (full bundled Chromium); `local-chrome` opts into installed Chrome with dedicated profiles and a loopback API. |
| `COMPUTER_BROWSER_MODE`              | Managed defaults to `headed` on Linux, which is every hosted computer (a container, a pod, the desktop app's engine): full Chromium on the computer's own Xvfb display. A computer run directly on macOS or Windows defaults to `headless`, where headed would open windows on the desktop. `headless` is full Chromium's new headless mode. Local Chrome requires `headed`. See [Getting past bot checks](#getting-past-bot-checks). |
| `OPENBOT_LOCAL_COMPUTER_DIR`         | Local startup helper's absolute data root. Defaults to the platform's OpenBot user-data directory; contains `profiles/` and `workspace/`. |
| `COMPUTER_SUPERVISOR_URL`            | Supervisor URL for per-Bot computers. If absent, Bots share `AGENT_COMPUTER_URL`.         |
| `SUPERVISOR_TOKEN`                   | Bearer token required by the supervisor.                                                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Local-only private-host browsing when `true`. A deployment running with `NODE_ENV=production` refuses to start while it is set. Cloud metadata addresses are refused either way. |
| `AGENT_ENDPOINT_ALLOWED_HOSTS`       | Private addresses an agent may be registered at, comma separated; unset (none) by default. Host, optionally with a port. Exact match; no wildcards. Never-allowed addresses cannot be named. |
| `AGENT_COMPUTER_POLICY`              | JSON action policy: `{"mode":"enforce","deny":[...],"allow":[...]}`.                      |
| `COMPUTER_RUNTIME`                   | Set to `runsc` to run supervised computers under gVisor.                                  |
| `COMPUTER_SANDBOX`                   | Set to `on` to enable Chromium's own sandbox where the host permits user namespaces. Which way it went is printed at start-up. |

`COMPUTER_SANDBOX` toggles Chromium's own process sandbox on a Docker computer.

Changing `COMPUTER_BROWSER_MODE` affects new supervised computers. A computer that already exists is
left running until its image changes or its container is recreated. To apply a mode-only change to
all computers while preserving their browser profiles and workspaces, apply the new supervisor
environment and remove only the owned containers (do not remove their volumes):

```sh
docker ps -aq --filter "label=openbot.namespace=openbot" | xargs -r docker rm -f
```

The supervisor recreates each computer with the same named volumes on its next request.

### Headed or headless managed Chromium in Docker

The managed backend uses Playwright's full `chromium` channel in either mode. The Docker image
already installs that browser and Xvfb; it does not require Google Chrome. Headed is the default in
Compose (`agent-computer` and the computers the supervisor creates). The computer starts its own Xvfb, so nothing appears on any screen
and the live screen, take control and hand back work exactly as before. Headed costs a little more
memory and CPU than headless.

To run headless instead, set `COMPUTER_BROWSER_MODE=headless` for Compose and recreate the shared
computer or supervisor as applicable:

```sh
docker compose up -d --force-recreate agent-computer supervisor
```

Existing supervisor-created computers retain their mode until recreated as described above. The
same per-Bot profile volumes and streamed viewer continue to work. A headless computer's user agent
and client hints report what
the same browser reports headed.

### Installed Chrome for a local API deployment

This source/deployment-checkout option launches a separate installed Google Chrome window for each
active Bot on macOS or Windows. The existing in-app viewer, browser tools, authentication, and Bot
access policy still apply. Linux uses a private Xvfb display and the viewer. This is not a packaged
desktop toggle or a bridge from a hosted API: the API must run on the same machine and reach the
helper through loopback.

Install [Bun](https://bun.com/docs/installation) and [Google Chrome](https://www.google.com/chrome/)
in its standard location, then install dependencies from the checkout root:

```sh
bun install --frozen-lockfile
bun install --cwd agent-computer --frozen-lockfile
```

Use the same existing `COMPUTER_TOKEN` for the API and helper. It can be set in the checkout's `.env`
(Bun loads it) or supplied securely in each process environment; the helper never prints it. Set the
following API configuration and clear the supervisor URL, including any inherited process
environment value, because it takes precedence over the shared URL:

```dotenv
AGENT_COMPUTER_URL=http://127.0.0.1:4101
COMPUTER_SUPERVISOR_URL=
```

In the helper's environment, leave `COMPUTER_BROWSER_BACKEND` and `COMPUTER_BROWSER_MODE` unset, or
set them to `local-chrome` and `headed`. An inherited `managed` or `headless` setting is an error.
Leave `PORT` unset for 4101, or explicitly choose another port and update the API URL to match. Start:

```sh
bun scripts/start-local-chrome-computer.ts
```

Restart the API with the configuration above. Open a Bot's computer and navigate to a website; its
dedicated Chrome window starts on first use. Use **Take control** in the app before interacting and
**Hand back** when finished. Closing a viewer does not close the Bot's browser or erase its logins.
The helper exits with an error for a missing token, missing Chrome, or occupied port instead of
silently selecting another browser or port. Ctrl-C shuts down its computer process and browsers.

The helper ignores inherited `PROFILES_DIR` and `WORKSPACE_DIR`. Its defaults are:

- macOS: `~/Library/Application Support/OpenBot/local-computer`
- Windows: `%LOCALAPPDATA%\OpenBot\local-computer`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/openbot/local-computer`

Set `OPENBOT_LOCAL_COMPUTER_DIR` to an absolute, dedicated app-owned directory to change that root.
Do not point it at your personal Chrome data. Each Bot uses a separate persistent subdirectory under
`profiles/`; no existing Chrome session is attached, and no TCP debugging endpoint is exposed.
Native Chrome retains its process sandbox and OS credential store. File tools remain confined to
the helper's `workspace/`, and shell execution is refused: use OpenBot's separately approved host
access tools for host commands. Native Chrome runs with your OS account's network access; this mode
is not a container or an OS network sandbox. Keep the API's private-host browsing opt-in off unless
you intentionally need it for your local deployment.

To switch back, stop the helper, restore your prior `AGENT_COMPUTER_URL` and supervisor/sandbox
selectors, and restart the API. Unset `COMPUTER_BROWSER_BACKEND` (or set `managed`) on the managed
computer process; choose `headless` or `headed` as before. Local Chrome profiles remain in the local
data root, separate from managed computer volumes.

`agent-computer` also reads:

- `ACTION_TIMEOUT_MS`
- `NAVIGATION_TIMEOUT_MS`
- `WORKSPACE_DIR`
- `PROFILES_DIR`
- `COMPUTER_BOT_ID`
- `EGRESS_PROXY_DEFAULT` (in `egress.env`, see below)
- `EGRESS_PROXY_<BOT_ID>` (in `egress.env`, see below)
- `COMPUTER_SHELL_ENV`

A command on the computer inherits PATH, locale and terminal names, and the proxy variables, not
the rest of the process environment. Userinfo is stripped from a proxy URL, so a password in
`HTTP_PROXY` is not in `env`. `COMPUTER_SHELL_ENV` is a comma-separated list of extra names to
pass. Naming a secret or a credentialed proxy there is an operator's decision; the default does not.

### Per-Bot egress

The two egress variables live in `egress.env` at the repository root, not in `.env`. `EGRESS_PROXY_<BOT_ID>`
is derived from a Bot's id, so there is no fixed set of names for Compose to list the way it lists
every other variable, and Compose passes a container only the names it is given. A file of its own
rather than `.env` because that one holds the deployment's secrets and neither the browser container
nor the supervisor is given those.

```sh
# egress.env
EGRESS_PROXY_DEFAULT=http://user:password@proxy.internal:8080
EGRESS_PROXY_SALES_BOT=http://sales.proxy.internal:8080
```

The file is optional and gitignored. Without it every Bot's browser goes out directly, which is the
default. Both the shared computer and the supervisor are given it: the computer resolves its own
proxy from these names, and the supervisor forwards them into each computer it creates.

Proxy selection is read from the environment when a Bot's browser is created. Restart that browser to apply a changed upstream proxy.

The supervisor also reads:

- `COMPUTER_IMAGE`
- `COMPUTER_NAMESPACE`
- `COMPUTER_NETWORK`
- `COMPUTER_MEMORY_BYTES`
- `DOCKER_SOCKET`

`ENGINE_SOCKET` is separate from those, because it is read by Compose rather than by the supervisor:
it is the host path mounted into the supervisor as `/var/run/docker.sock`. Unset, it is
`/var/run/docker.sock`, which is right for Docker and for Podman on macOS, where `podman machine`
symlinks that path to the rootless socket. Rootless Podman on Linux needs
`ENGINE_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`: there the default path is either missing or a
symlink to the rootful socket, which is not the one running, and the supervisor reports that it
cannot reach Docker.

`COMPUTER_NAMESPACE` defaults to `openbot` and names the deployment a computer belongs to. It is part
of every container and volume name the supervisor derives, and the supervisor acts only on computers
carrying it, so two deployments on one Docker host never adopt each other's.

Per-Bot computers belong to the supervisor rather than to Compose, so `docker compose down -v` does
not remove them: their containers keep running and their profile volumes, which hold whatever the
Bots are signed in to, survive. Remove them by the label the supervisor sets:

```sh
docker ps -aq --filter "label=openbot.namespace=openbot" | xargs -r docker rm -f
docker volume ls -q --filter "label=openbot.namespace=openbot" | xargs -r docker volume rm
```

Proxy credentials may appear in proxy URLs, but the computer strips them before reporting proxy status.

### Site challenges and sign-in

Use the real persistent browser session. A site's challenge or sign-in requirement is reported from the page, not inferred from a missing connector. `computer_request_help` or `computer_request_sign_in` creates a genuine waiting tool: the person takes the live browser, completes that step and releases it. The tool resumes in the same session. This does not promise that any particular website will accept automation.
#### Residential or ISP proxy

`EGRESS_PROXY_DEFAULT` (and `EGRESS_PROXY_<BOT_ID>`, see [Per-Bot egress](#per-bot-egress)) takes a
residential or ISP proxy's gateway URL, credentials included:

```sh
# egress.env
EGRESS_PROXY_DEFAULT=http://customer-user:password@gateway.residential.example:8000
```

It reaches the shared computer and every per-Bot computer as `EGRESS_PROXY_DEFAULT`. The egress
filter chains to it, so the network policy still decides what a Bot may reach, and the proxy's
credentials are split out before Chromium or any status report sees them.

**This is the operator's choice, and it is off by default.** Through a residential proxy, a Bot's
traffic leaves from an address a consumer ISP owns, so a site sees what looks like a person at home
rather than a datacenter. That is why it works, and it is a choice to make knowingly: it changes
the network route. It does not remove the need for a person when a site requires human input.


## Images

Every service `docker-compose.yml` can build is published by a release, so a machine can run the
stack without a toolchain and without waiting for Chromium to build.

| Service           | Setting             | Published image                            |
| ----------------- | ------------------- | ------------------------------------------ |
| `agent-computer`  | `COMPUTER_IMAGE`    | `your-registry/pdsduet-agent-computer` |
| `supervisor`      | `SUPERVISOR_IMAGE`  | `your-registry/pdsduet-supervisor`     |
| `agent-langgraph` | `LANGGRAPH_IMAGE`   | `your-registry/pdsduet-agent-langgraph`|
| `migrate`         | `SERVER_IMAGE`      | `your-registry/pdsduet-server`         |

Unset, each names a local tag and Compose builds it, which is what a checkout of this repository
does. Set to a published reference, pinned by digest, together with `IMAGE_PULL_POLICY=missing`,
Compose pulls instead. Both architectures are in every image, so the same reference works on an
arm64 laptop and an amd64 server.

`IMAGE_PULL_POLICY` is needed because a service carrying a `build` section builds by default
however its image is named. It is also not a promise that nothing is built: a pull that fails falls
back to building, which suits a developer and does not suit a machine with no toolchain, where the
useful answer is that the image could not be fetched. Somewhere that must never build, override the
`build` sections away instead.

`docs/releasing.md` shows reading the digests straight out of a release's `container-images.json`.

## Ports

| Service           | Default port               | Setting           |
| ----------------- | -------------------------- | ----------------- |
| `app`             | 3010                       | `APP_PORT`        |
| `server`          | 3001                       | `SERVER_PORT`     |
| `agent-computer`  | 4100                       | `COMPUTER_PORT`   |
| `agent-langgraph` | 4201                       | `LANGGRAPH_PORT`  |
| `supervisor`      | 4500 host / 4300 container | `SUPERVISOR_PORT` |
| PostgreSQL        | 5432                       | `POSTGRES_PORT`   |

Set these in `.env` or in the environment. `docker-compose.yml` publishes on them and
`scripts/start.sh` reads the same names to decide where to look, so one setting moves a service and
everything that talks to it. The addresses built from them are separate settings, so a moved service
also needs its URL changed, such as `DATABASE_URL`, `AGENT_COMPUTER_URL` or a Bot's explicit remote endpoint.

To run two deployments on one Docker host, give the second one its own `COMPOSE_PROJECT_NAME`,
`COMPUTER_NAMESPACE` and `COMPUTER_IMAGE`. Container and volume names are global to a host, and the
namespace is what keeps each deployment's per-Bot computers its own.

Set `OPENBOT_ONE_COMPUTER_EACH=false` when using `start.sh` to run all Bots against one shared computer.

## Tenant package

The default tenant package is `examples/openduet`. Set `TENANT_PACKAGE_DIR` to use an external or custom package; relative paths are resolved from `server/`. Desktop Start preserves an explicitly configured value instead of rewriting it.

For an older Desktop installation, an existing `.env` may explicitly contain `TENANT_PACKAGE_DIR=../examples/fintech`. That bundled example has been retired. Change the value to `../examples/openduet` or a valid custom package path. This change does not rewrite existing `.env` files or convert saved data.

The package contains five required YAML files. `skills.yaml`, `agents/`, and `theme.css` are optional:

```text
examples/openduet/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
├── knowledge.yaml
├── skills.yaml      (optional)
├── agents/          (optional, one coworker per file)
└── theme.css        (optional)
```

### `brand.yaml`

```yaml
tenant:
  id: openduet
  product_name: OpenDuet
```

Optional theme:

```yaml
skin:
  stylesheet: theme.css
```

Theme CSS may define only `:root` and `.dark` blocks, approved theme variables, and no `@import` or `url()`.

### `agents.yaml`

The shipped file defines 保險 PDF 文案總監 as a remote AG-UI Bot on the local LangGraph endpoint and 搜索機器人 as a built-in Bot using Google AI Mode. Their complete instructions remain in `examples/openduet/agents.yaml`.

Each agent requires `id`, `name`, `title`, `role_description`, and `type`.

| Type            | Required field  |
| --------------- | --------------- |
| `built-in`      | `system_prompt` |
| `remote-ag-ui`  | `endpoint`      |
| `remote-mastra` | `endpoint`, and optionally `remote_agent_id` to pick one agent on that Mastra server |

A remote agent whose `endpoint` resolves to an empty string is left out rather than refused, and it
is dropped from every channel's `permitted_agents` too. Custom packages can use this for optional
remote Bots.

An agent may list `skills:`, slugs of skills this package ships in `skills.yaml`. A slug the package
does not ship, or the same slug twice, stops the server. Two agents with the same `id` in
`agents.yaml` stop it as well.

The two types are told different amounts, which is easy to miss. A `built-in` agent gets its
`system_prompt`; a `remote-ag-ui` agent has none, and its `role_description` is the only instruction
it ever receives from the package. Write that sentence as the whole brief for the Bot, not as a
label for a list.

Both kinds are also told, by the deployment rather than by the package, to say where an answer came
from: cite what a tool returned, and say plainly when the answer is from the model's own knowledge
rather than from anything it read. That rule is not written per agent, so it cannot be missing from
the next one somebody adds.

Any `${NAME}` in a package file is replaced with that environment variable, so one package works
against a local stack, a staging one and production. `${NAME:-fallback}` uses the fallback when the
name is unset or empty, allowing a custom package to declare an optional remote endpoint. A name with neither a value nor a fallback stops the server with a
message saying which file wanted it, rather than leaving a Bot pointed at an address nobody meant.

### `agents/`

A coworker may also be one file of its own, in an `agents/` directory beside `agents.yaml`. Both are
read, and a package that keeps every coworker in `agents.yaml` is unchanged.

Place each custom coworker's fields in its own `.yaml` or `.yml` file. No optional `agents/` directory is shipped by default.

The file holds the coworker on its own, or a list under `agents:` the way `agents.yaml`
does. Only `.yaml` and `.yml` are read, so a README beside them is left alone. Files are read in
filename order, and every check that applies to a row in `agents.yaml` applies here too: a refusal
names the file it came from.

Two files declaring the same `id`, or a file repeating an id `agents.yaml` already uses, stop the
server and both files are named. Nothing wins by being read later — which coworker a deployment runs
should not depend on what a directory listing happened to return.

The directory is in the package checksum, so adding, editing or deleting a coworker there is a
package change like any other and a running deployment notices it on the next boot.

**Deleting a file does not remove the Bot from a deployment that already registered it.** The next
boot stops declaring it, but its row stays, still owned by the package, so it is still listed and
still refused by delete as protected. Only a remote coworker whose `endpoint` is blank is retired
automatically. Retire one that is gone from the package by setting `deleted_at` on its
`agent_profiles` row, which is what delete does for a Bot somebody made.

### `channels.yaml`

```yaml
channels: []
```

Each channel requires `id`, `name`, `description`, `permitted_agents`, and `allowed_groups`. Every `permitted_agents` entry must match an agent id. A channel `id` declared twice, or an agent listed twice in one channel, stops the server.

`allowed_groups` is validated and stored, and nothing reads it. It decides nothing today, and a
deployment that writes one must not treat it as an access control. Both halves of that control are
missing, not one: `users.groups` exists as a column and no sign-in path, claim mapping or admin
screen ever populates it, so there is nothing for a channel's list to be compared against. Channel
access is decided by membership alone — every channel route resolves the caller's row in
`channel_memberships` and refuses without it.

Package-declared channels get no membership rows from `synchronizeTenantPackage`, so today they
are unreachable rather than open. The field is kept because the enforcement it is named for needs
the declaration and needs group membership arriving from the identity provider, and neither this
column nor `users.groups` is the wrong shape for it.

### `model.yaml`

```yaml
model:
  provider: openai
  credential_secret_ref: openai-api-key
  default_model: gpt-5.6-terra
```

`provider` must be `openai` or `anthropic`. `credential_secret_ref` is a reference to a stored credential, not a credential value. `default_model` is passed through as written, so an OpenAI-compatible endpoint reached through `OPENAI_BASE_URL` takes the name that endpoint publishes.

At start-up the server asks OpenAI or Anthropic, once, whether the configured key can call `default_model`. A key that cannot (a project key whose model allowlist leaves it out, say) would otherwise fail at the first message; instead the log says `model-unavailable`, naming the model and the fix. A rejected key logs `model-credential-rejected`. Nothing is asked with no key configured yet, or of an endpoint set by `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, and start-up never waits for the answer.

### `knowledge.yaml`

```yaml
sources: []
```

The shipped package declares no knowledge sources. Custom packages can declare `google-drive` or `microsoft-onedrive` sources.

### `skills.yaml` (optional)

```yaml
skills:
  - slug: find-a-document
    title: Find a document
    summary: Search the connected document sources for a file and read what it says.
    instructions: >-
      Search first, then read the file you found rather than answering from its title.
    tools:
      - google-drive/search_files
      - google-drive/read_file_content
```

Each skill becomes a deployment skill on boot: everybody sees it in the `/` menu, and which Bots carry it is decided in Admin like any other.

`tools` is why this file matters beyond the instructions. A Bot holding more than twelve tools is offered, per run, only the tools of the skills that match the message, so the matching needs skills to match against. Shipping the declaration with the skill is what makes connecting a connector the only step; without it a deployment has no skills, nothing matches, and the narrowing never switches on.

Refs are `serverId/toolName`, the same form a grant is written in. A package may name tools for a connector nobody has added — the ref sits inert until that connector exists, because what a Bot is offered is always intersected with what it was granted. **Naming a tool here grants nothing.**

Create and edit skills through the Skills page, then explicitly grant them to the intended Bots. A skill contains instructions and declared tool references; it does not implicitly register browser authoring tools. See [architecture.md](architecture.md#creating-and-editing-skills).

Slugs are 2 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit, the same rule the skills API and the app's form apply. A slug declared twice in `skills.yaml` stops the server. If a package ships a slug somebody in the deployment already wrote a skill under, theirs keeps the name, the package loses that skill, and startup continues.

Omit the file entirely for a package with no skills.

## Change workflow

1. Edit the relevant `.env` value or tenant YAML file.
2. Check cross-file references, especially `channels[].permitted_agents`.
3. Keep credential values and service-account JSON out of YAML.
4. When explicitly authorized, restart the API server; invalid configuration stops startup.
5. Read the changed source, configuration, and diff. Do not add or run tests; build, startup, and runtime operations require explicit authorization.
