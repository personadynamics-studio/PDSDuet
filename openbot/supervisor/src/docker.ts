import Docker from "dockerode";
import { BOT_LABEL, type ComputerNames, NAMESPACE, NAMESPACE_LABEL, OWNER_LABEL } from "./names";

const docker = new Docker(process.env.DOCKER_SOCKET ? { socketPath: process.env.DOCKER_SOCKET } : undefined);
const COMPUTER_PORT = "4100/tcp";

export type ComputerState = {
  botId: string;
  container: string;
  status: string;
  startedAt?: string;
  port?: number;
  url?: string;
};

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(`The supervisor could not reach Docker (${cause}).`);
    this.name = "DockerUnavailableError";
  }
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function labelsFor(names: ComputerNames): Record<string, string> {
  return { [OWNER_LABEL]: "true", [BOT_LABEL]: names.botId, [NAMESPACE_LABEL]: NAMESPACE };
}

export async function reachable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function listOwned(): Promise<ComputerState[]> {
  try {
    const containers = await docker.listContainers({ all: true, filters: { label: [`${OWNER_LABEL}=true`, `${NAMESPACE_LABEL}=${NAMESPACE}`] } });
    return containers.map((container) => ({
      botId: container.Labels?.[BOT_LABEL] ?? "unknown",
      container: (container.Names?.[0] ?? "").replace(/^\//, ""),
      status: container.State,
      ...(container.Created ? { startedAt: new Date(container.Created * 1000).toISOString() } : {}),
      ...(container.Ports?.find((port) => port.PrivatePort === 4100)?.PublicPort ? { port: container.Ports.find((port) => port.PrivatePort === 4100)!.PublicPort } : {}),
    }));
  } catch (error) {
    throw new DockerUnavailableError(String(error));
  }
}

export type EnsureOptions = {
  image: string;
  environment: string[];
  network?: string;
  runtime?: string;
  memoryBytes?: number;
};

function hostConfig(names: ComputerNames, options: EnsureOptions) {
  return {
    Binds: [
      `${names.profileVolume}:/profiles`,
      `${names.workspaceVolume}:/workspace`,
    ],
    ...(options.network ? { NetworkMode: options.network } : { PortBindings: { [COMPUTER_PORT]: [{ HostPort: "" }] } }),
    ...(options.runtime ? { Runtime: options.runtime } : {}),
    RestartPolicy: { Name: "unless-stopped" },
    SecurityOpt: ["no-new-privileges:true"],
    CapDrop: ["ALL"],
    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),
    ShmSize: 1_073_741_824,
  };
}

export async function ensure(names: ComputerNames, options: EnsureOptions, signal?: AbortSignal): Promise<ComputerState> {
  try {
    let container = docker.getContainer(names.container);
    let info;
    try {
      info = await container.inspect({ abortSignal: signal });
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    if (!info) {
      for (const volume of [names.profileVolume, names.workspaceVolume]) {
        await docker.createVolume({ Name: volume, Labels: labelsFor(names), abortSignal: signal });
      }
      container = await docker.createContainer({ name: names.container, Image: options.image, Labels: labelsFor(names), Env: options.environment, ExposedPorts: { [COMPUTER_PORT]: {} }, HostConfig: hostConfig(names, options), abortSignal: signal });
    }
    if (!info?.State?.Running) {
      await container.start({ abortSignal: signal });
      info = await container.inspect({ abortSignal: signal });
    }
    const published = info.NetworkSettings?.Ports?.[COMPUTER_PORT]?.[0]?.HostPort;
    const port = published ? Number(published) : undefined;
    return {
      botId: names.botId,
      container: names.container,
      status: info.State?.Status ?? "unknown",
      ...(info.State?.StartedAt ? { startedAt: info.State.StartedAt } : {}),
      ...(port ? { port } : {}),
      ...(options.network ? { url: `http://${names.container}:4100` } : port ? { url: `http://127.0.0.1:${port}` } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw new DockerUnavailableError(String(error));
  }
}

export async function stop(names: ComputerNames): Promise<boolean> {
  try {
    await docker.getContainer(names.container).stop({ t: 30 });
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    if (statusOf(error) === 304) return true;
    throw new DockerUnavailableError(String(error));
  }
}

export async function reset(names: ComputerNames): Promise<boolean> {
  try {
    await docker.getContainer(names.container).remove({ force: true, v: false });
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw new DockerUnavailableError(String(error));
  }
  try {
    await docker.getVolume(names.profileVolume).remove();
  } catch (error) {
    if (statusOf(error) !== 404 && statusOf(error) !== 409) throw new DockerUnavailableError(String(error));
  }
  return true;
}
