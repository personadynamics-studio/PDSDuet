import { isAbsolute, relative, resolve, sep } from "node:path";

export function profileDirectoryFor(root: string, botId: string): string {
  if (!botId || botId === "." || botId === ".." || /[\\/]/.test(botId)) {
    throw new Error("A computer identifier must name one folder.");
  }
  const base = resolve(root);
  const target = resolve(base, botId);
  const path = relative(base, target);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("The computer folder must be inside its workspace root.");
  }
  return target;
}
