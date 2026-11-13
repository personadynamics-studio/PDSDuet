# Local execution and telemetry

CopilotKit runtime and desktop telemetry have been removed. No CopilotKit project, telemetry identity or licence is configured.

Conversation history, tool results, execution state and reconnect events belong to the local PostgreSQL backend. Automatic learning, learned-skill delivery, cloud memory mirroring and semantic recall have been removed. No existing records are imported or migrated.

The application's local audit trail remains separate from the removed vendor analytics. Optional OpenTelemetry audit export is configured explicitly through the existing OTLP settings.
