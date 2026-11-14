import { timingSafeEqual } from "node:crypto";

/** Compare credentials used by the model OAuth proxy and desktop host access. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
