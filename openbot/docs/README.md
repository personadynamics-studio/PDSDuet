# PDSDuet / OpenBot docs

Start with the [PDSDuet README](../../README.md) at the repository root, then use these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Development](development.md): local setup, database initialization, ports, and source review.
- [Coworkers](coworkers.md): durable Bot profiles, channels, visibility, deletion, and external AG-UI registration.
- [Public-web research](web-research.md): search and page reading through Parallel, Exa or Firecrawl.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Composio](plugins/composio.md): the broker, and so the one page here that is a catalogue of apps rather than a single connector.
  - [Google Drive](plugins/google-drive.md)
  - [Gmail and Google Calendar](plugins/google-workspace.md)
  - [Notion](plugins/notion.md)
- [Deployment](deployment.md): source and Compose startup, the API image, database initialization and persistent computer data.
- [Releasing](releasing.md): desktop version tooling and deploying published images.
- [Windows desktop signing](windows-signing.md): the remaining signing scripts and desktop configuration.
- [Desktop provider OAuth](../desktop/PROVIDER_OAUTH.md): what a distributor configures to offer Google and xAI sign-in in a desktop build.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
