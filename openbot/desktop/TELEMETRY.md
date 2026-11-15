# Desktop telemetry

Telemetry is enabled by default. Welcome discloses it without an opt-in gate. Launch OpenBot with either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1` to disable both the desktop emitter and the runtime. Both variables accept `true` or `1`. Quit and relaunch after changing the environment. Opting out removes pending desktop events and prevents recording or replay.

The native emitter starts before credentials are available. It persists a random installation UUID and a bounded queue in the app's local data directory. It does not derive identity from the machine. The runtime receives the same UUID through `CPK_TELEMETRY_ID` and uses sampling rate 1; opt-out still takes precedence.

## Event allowlist

All desktop event names begin with `oss.desktop.`. The Rust `EventData` enum and `schema_json()` define the closed property schema; deserialization rejects unknown properties and enum values.

| Event suffix | Properties |
| --- | --- |
| `step_viewed` | Setup step enum |
| `harness_chosen` | Harness enum, including `byo_url` |
| `model_chosen` | Provider and credential-path enums; custom-base-URL boolean |
| `engine_detected` | Engine enum; responding boolean |
| `engine_installed` | Engine and installer-outcome enums |
| `windows_stage` | Windows prerequisite outcome enum |
| `image_pull` | Outcome enum, milliseconds, optional observed download bytes |
| `setup_failed` | Setup step and error-class enums |
| `activated` | No properties; first successful setup Bot answer |
| `setup_abandoned` | Last setup step enum |

Every event carries desktop distribution, numeric app version, platform, architecture, numeric OS version when available, and engine. The runtime receives the same desktop metadata through its existing `telemetryProperties` hook. No prompt, answer, credential, file name, path, hostname, email, model name, YAML value, or custom URL is accepted by the desktop schema.

Image timing covers an explicit missing-only Compose pull, excluding startup and migrations. Byte counts are the download counters observed from Compose, deduplicated per layer; they are not an exact network total. Missing counters remain null. Older Compose providers without `pull --policy missing` retain their existing implicit pull behavior and emit no pull measurement.

## Delivery

Events persist before sending and keep their event IDs across retries. The queue holds at most 256 events, dropping the oldest on overflow. Background delivery, bounded quit flushing, and replay on relaunch use the existing CopilotKit ingest contract. A crash before activation records abandonment on the next launch. Telemetry failures do not block setup.

The ingest must accept the new `oss.desktop.*` namespace: [oss-path-to-production #290](https://github.com/CopilotKit/oss-path-to-production/pull/290). A successful HTTP response alone does not prove downstream acceptance; production ingest acknowledges filtered events too. Merge and deployment of that change are required for production desktop delivery.
