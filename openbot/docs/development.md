# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.3+, `lsof`, `openssl`, and `curl`. The
`scripts/start.sh` uses `openssl` to mint generated secrets on a first run.

```sh
cp .env.example .env
bun install
```

Set `DATABASE_URL`, `KEY_ENCRYPTION_KEY`, the model credential, and the sign-in settings in `.env`.
Conversation history, tool results, run state and reconnect events are stored in the local PostgreSQL database.
There is no Intelligence project, learning container, licence or telemetry setup.

Start the stack:

```sh
bash scripts/start.sh
```

## Running services

Use `bash scripts/start.sh` for the local stack. It starts the selected Docker services, runs database initialization, builds the frontend, and starts the API and frontend servers.

Use `bash scripts/stop.sh` to stop the app, API, Docker services, and this deployment's Bot computers. Pass `--keep-computers` to leave the Bot computers running. Database and browser-profile volumes remain.

Use `bun run dev` only when you want the app and API server without starting the Docker Bots and computers.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-computer`  | 4100                       |
| `agent-langgraph` | 4201                       |
| `supervisor`      | 4500 host / 4300 container |
| PostgreSQL        | 5432                       |

The app and the API server listen on this machine only (127.0.0.1 and ::1) while there is no
sign-in, because whoever reaches them is the administrator; to open them to your network, set
`OPENBOT_HOST` in `.env` (see [Where it listens](configuration.md#where-it-listens)). Opened at a
host name other than `localhost`, rather than at an IP address, the app loads but every change it
asks for is refused until that origin is in `TRUSTED_ORIGINS`.

`start.sh` applies the selected Docker services, rebuilds the frontend, and replaces the API and frontend processes recorded by the previous local start.

**Nothing here sweeps staged attachments.** A file dropped into the composer is stored before the
message is sent, and the only thing that reclaims the ones never sent is
`bun scripts/cull-staged-attachments.ts` from `server/`; neither `docker-compose.yml` nor `start.sh`
starts it. It needs only `DATABASE_URL`, and takes a
retention window in hours as its one optional argument, defaulting to 24. On a laptop that is
usually nothing, because the rows are small and the database is yours. It stops being nothing at
thirty-two: one person may hold that many unsent files across every channel at once, the refusal on
the next one promises they are cleared within a day, and where nothing sweeps they are not, so a
long-lived local deployment can reach a state where attaching anything is refused. Removing a file
in the composer deletes it outright, so it takes abandoned drafts rather than ordinary use.
[deployment.md](deployment.md) says the same for a real deployment.

## Database initialization

`server/schema.sql` defines the current schema. The server's existing `db:initialize` script runs
`server/scripts/initialize.ts` to initialize an empty database; `start.sh` invokes it through the
Compose `initialize` service. Existing databases are left unchanged. Normal API startup does not
run schema migrations or historical data repairs.

## Reviewing changes

Read the relevant source, configuration, references, and diff. Do not create or run tests. Build,
startup, and runtime operations require explicit authorization; report any unexercised runtime behavior.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../../README.md) when behavior changes.
- Include the source review and any runtime behavior left unexercised in the pull request.
