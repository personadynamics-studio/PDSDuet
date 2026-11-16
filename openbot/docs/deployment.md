# Deployment

The supported stack uses the shared web app, API, PostgreSQL, and a managed computer service.
Phones and desktop browsers use the same web app. The desktop shell opens that app after starting
its local deployment.

## Source checkout and desktop bundles

From `openbot/`, configure `.env` using `.env.example`, install the dependencies, and start the
existing local stack:

```sh
bun install
bash scripts/start.sh
```

The script starts the selected Compose services, initializes an empty database, builds the frontend,
and starts the API and frontend processes. PostgreSQL and computer services remain separate
containers. The Docker supervisor provides one computer per Bot; a deployment can instead select
the shared computer URL.

A desktop bundle contains this project's source and a `container-images.json` naming its images.
The shell does not download or replace the bundle with an upstream release.

## API image

`server/Dockerfile` builds the API together with the web app it serves. From `openbot/`:

```sh
docker build -f server/Dockerfile -t pdsduet-api .
```

This image contains neither PostgreSQL nor Chromium. Set `DATABASE_URL` to a database reachable
from the container and configure `COMPUTER_SUPERVISOR_URL` or `AGENT_COMPUTER_URL` for its computer
service. Use this project's Compose services or explicitly supplied service addresses.

The API listens on port 3001 inside its container. Without an identity provider, publish that port
on loopback because every admitted request uses the existing shared administrator actor. Configure
Google, Microsoft or Okta for account-based shared access; see [Configuration](configuration.md).
`INITIAL_ADMIN_EMAILS` is optional: listed addresses remain administrators, while other accounts use
the roles managed through People.

## Database initialization

`server/schema.sql` owns the fresh database schema. The Compose `initialize` service runs
`server/scripts/initialize.ts` against an empty database. For an API deployment outside that local
startup flow, run the same initializer explicitly before starting the API.

Initialization does not migrate existing records, import old data or rebuild conversation history.
The application database role needs permission to create the schema's tables, indexes and enums.

## Persistent data and API ownership

Keep PostgreSQL data, browser profiles and workspaces on their existing volumes. Stopping the stack
or replacing a computer container does not require deleting its volumes. A computer reset is
different: it deliberately clears that Bot's browser profile and signs it out.

Run one API owner for a deployment. Execution waiting state and event replay are durable, while
active execution and model state belong to that API process. Horizontal replicas or overlapping API
owners are not supported.

## Staged attachments

The local startup flow does not schedule attachment cleanup. From `server/`, the existing
`bun scripts/cull-staged-attachments.ts` command removes unsent attachments older than its retention
window (24 hours by default, or the optional argument in hours). A deployment that needs periodic
cleanup schedules that command separately with `DATABASE_URL`. The server does not promise a
cleanup schedule on the deployment's behalf.
