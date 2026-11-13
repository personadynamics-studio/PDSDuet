export const LISTEN_HOST_VARIABLE = "OPENBOT_HOST";
export type ListenHost = { host: string | undefined };

export function listenHosts(raw?: string): ListenHost[] {
  return raw?.trim()
    ? raw.split(",").map((host) => ({ host: host.trim() }))
    : [{ host: undefined }];
}

export function listenAddress(host: string | undefined, port: number): string {
  return host ? `http://${host.includes(":") ? `[${host}]` : host}:${port}` : `every interface on port ${port}`;
}
