# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                                                  |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | Type (built-in, remote AG-UI or remote Mastra), endpoint or prompt, optional key reference. |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, visibility, and soft deletion.                    |
| Personal roster      | `agent_preferences`             | Per-user hidden and pinned state.                                                        |
| Team publication     | `team_bot_publications`         | A Bot its owner has published to the whole team or to named people and groups.          |
| Channel              | `channels`                      | Conversation membership and coworker binding.                                            |
| Thread mapping | Local PostgreSQL thread records | Channel-to-thread mapping.                                                               |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

A further provenance block is appended by the deployment rather than the package: it tells the
coworker to say where each answer came from, to mark plainly anything it answers from its own
knowledge rather than from a source, and never to present the latter as the former. A second block
tells it how to read the untrusted-content envelope its tool results carry. Being deployment-wide,
both cannot be forgotten from the next coworker somebody adds.

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner, administrators and the audience of an active Team Bot publication. |
| `public`   | Everyone in the deployment. |

Profile reads and runtime loading share the same server/database predicate. Only the owner or an administrator can edit or delete a Bot; an administrator manages ownerless package Bots. Hiding, pinning and duplicating a visible Bot affect the person's own roster or create their own copy.

An owner can also publish a Bot as a Team Bot, to everybody signed in or to named people and groups
(`/api/team-bots`, the Bot's **Sharing** page). Publishing is a separate, revocable record; the Bot's own
visibility is unchanged by it. Publication grants its audience access only once the Bot has a role
description and a name other than a placeholder such as "New Bot". A public Bot remains visible to
everyone regardless of those publication requirements.

Only the owner may publish or withdraw a Team Bot, including when an administrator is managing its
profile. Administrators may assign a published Bot to groups. The publication list uses the same
visibility predicate as the roster; the publication candidates are the owner's own unpublished Bots.

Direct computer access (REST, live WebSocket screen and sign-in form actions) is available to the
owner, administrators and users of a public Bot. A private Team Bot's audience may ask it to work,
but cannot directly take over its signed-in browser. A public Bot keeps its shared-browser behavior.
Stopping or resetting a Bot's computer requires the owner or an administrator.

A Team Bot reaches a Personal app through its **owner's own account** when the owner has connected
it — for everyone it is published to — and otherwise through the asker's own
account, with their consent. A Shared app is the governed alternative: one account that belongs to
the deployment, with an administrator approving who may use it through each Bot. See
[Composio → Shared apps](plugins/composio.md#shared-apps).

## Channels

Starting a channel creates a new conversation and local PostgreSQL thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding and pinning are personal roster state. Hiding removes the coworker from one user's list without disabling the coworker for anyone else; pinning moves it into the **Pinned** section at the top of `/bots` for that user only. A Team Bot an administrator assigned to a group is always pinned for its members.

## Runtime endpoint

A product-created Bot without an explicit remote endpoint runs through the API's Native factory
using its standing role. A remote Bot stores its own endpoint and optional encrypted credential.
Package-provided agents use their own `agents.yaml` configuration.

The retained TypeScript `agent-langgraph` service listens on `http://localhost:4201/ag-ui` in the
local stack. Register that address explicitly in a remote Bot or a tenant package when using it.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create a coworker from `/bots` and edit it from its page's **Setup**, and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.


## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot by administrators;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).
