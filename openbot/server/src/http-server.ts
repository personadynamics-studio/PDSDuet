import { DICTATION_HTTP_IDLE_SECONDS } from "@openbot/shared/dictation";
import { listenAddress } from "@openbot/shared/listen-host";
import { serve } from "bun";
import type { OpenBotRole } from "./auth/roles";
import { websocket as channelSocket } from "./channels/socket";
import type { ComputerGateway } from "./computer/gateway";
import { streamPathBotId } from "./computer/stream-path";
import type { DeploymentConfig } from "./config";
import type { DemonstrationRecorder } from "./demonstrations/recording";
import type { DemonstrationStore } from "./demonstrations/store";

/**
 * The server's front door: one Bun server that hands ordinary requests to the Hono app, proxies the
 * computer's live stream, and carries channel activity over websockets.
 *
 * Moved out of index.ts verbatim, with what it reads passed in.
 */

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

/** Start the configured listeners and return their addresses and a stop function. */
export function startHttpServer(deps: {
  port: number;
  config: DeploymentConfig;
  resolveRequestActor: (
    request: Request,
  ) => Promise<{ id: string; name: string; role: OpenBotRole }>;
  computerGateway: ComputerGateway | undefined;
  demonstrationStore: DemonstrationStore;
  demonstrationRecorder: DemonstrationRecorder;
  app: {
    fetch: (
      request: Request,
      env: { server: unknown },
    ) => Response | Promise<Response>;
  };
}): { addresses: string[]; stop: () => void } {
  const {
    port,
    config,
    resolveRequestActor,
    computerGateway,
    demonstrationStore,
    demonstrationRecorder,
    app,
  } = deps;

  const toStreamUrl = (baseUrl: string, botId: string) =>
    `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}`;

  const isProxiedStream = (data: SocketData): data is StreamData =>
    typeof (data as StreamData).upstream === "string";

  // Hono owns the socket's data once it has upgraded it; this hands its own back to it.
  const asChannelSocket = (ws: { data: SocketData }) =>
    ws as unknown as ChannelSocket;

  const options: Parameters<typeof serve<SocketData>>[0] = {
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/threads/") && url.pathname.endsWith("/events")) server.timeout(request, 0);
      if (url.pathname === "/api/audio/transcriptions") {
        server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
      }
      if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
      if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
      const streamBotId = streamPathBotId(url.pathname);
      if (
        streamBotId !== null &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (!config.computer) {
          return new Response("No computer is configured.", { status: 503 });
        }
        // The session guard, applied by hand because middleware does not run on an upgrade. An
        // unauthenticated socket here would be the whole point of the proxy defeated.
        const actor = await resolveRequestActor(request).catch(() => null);
        if (!actor) {
          return new Response("Sign in first.", { status: 401 });
        }
        let upstream: string;
        try {
          const streamBase = computerGateway
            ? await computerGateway.locate(streamBotId)
            : undefined;
          if (!streamBase) {
            return new Response("No computer address is configured.", {
              status: 503,
            });
          }
          upstream = toStreamUrl(streamBase, streamBotId);
        } catch (error) {
          // Said out loud rather than falling back to another Bot's computer, which is the failure this
          // whole path exists to prevent.
          return new Response(
            error instanceof Error
              ? error.message
              : "That Bot's computer could not be reached.",
            { status: 502 },
          );
        }
        const recording = await demonstrationStore.active(
          actor.id,
          streamBotId,
        );
        if (recording)
          upstream += `&recording=${encodeURIComponent(recording.id)}`;
        if (
          server.upgrade(request, {
            data: {
              upstream,
              ownerUserId: actor.id,
              botId: streamBotId,
              ...(recording ? { recordingId: recording.id } : {}),
            },
          })
        ) {
          return undefined as unknown as Response;
        }
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return app.fetch(request, { server });
    },
    websocket: {
      open(ws) {
        if (!isProxiedStream(ws.data)) {
          channelSocket.open(asChannelSocket(ws));
          return;
        }
        const stream = ws.data;
        const inward = new WebSocket(stream.upstream);
        stream.inward = inward;
        // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
        // should be dropped, not queued, because a stale frame is worse than a missing one.
        inward.onmessage = (event) => {
          if (stream.recordingId) {
            let recorded: unknown;
            try {
              recorded = JSON.parse(String(event.data));
            } catch {
              recorded = null;
            }
            if (
              recorded &&
              typeof recorded === "object" &&
              "type" in recorded &&
              recorded.type === "demonstration.action"
            ) {
              const data = stream;
              const message = recorded as {
                recordingId?: unknown;
                action?: unknown;
              };
              if (message.recordingId !== data.recordingId) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error:
                      "The recording identity changed. Stop and restart recording.",
                  }),
                );
                return;
              }
              demonstrationRecorder
                .capture(
                  data.ownerUserId,
                  data.botId,
                  data.recordingId ?? "",
                  message.action,
                )
                .catch((error) => {
                  console.error(
                    JSON.stringify({
                      type: "demonstration-capture-error",
                      error:
                        error instanceof Error ? error.name : "UnknownError",
                      context: { recordingId: data.recordingId },
                      timestamp: new Date().toISOString(),
                    }),
                  );
                  try {
                    ws.send(
                      JSON.stringify({
                        type: "error",
                        error:
                          "A browser step could not be saved. Stop and review the demonstration before continuing.",
                      }),
                    );
                  } catch {
                    /* A closed viewer cannot receive the already logged failure. */
                  }
                });
              return;
            }
          }
          try {
            ws.send(String(event.data));
          } catch {
            inward.close();
          }
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
      },
      message(ws, raw) {
        if (!isProxiedStream(ws.data)) {
          channelSocket.message(asChannelSocket(ws), raw);
          return;
        }
        if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
      },
      close(ws, code, reason) {
        if (!isProxiedStream(ws.data)) {
          channelSocket.close(asChannelSocket(ws), code, reason);
          return;
        }
        ws.data.inward?.close();
      },
    },
  };

  const listening: string[] = [];
  const servers: ReturnType<typeof serve>[] = [];
  for (const { host } of config.listen) {
    servers.push(
      serve<SocketData>({
        ...options,
        ...(host === undefined ? {} : { hostname: host }),
      }),
    );
    listening.push(listenAddress(host, port));
  }
  return {
    addresses: listening,
    stop: () => {
      for (const server of servers) server.stop(true);
    },
  };
}
