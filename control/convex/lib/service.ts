// Gateway-only access. Every public function takes `secret` and checks it
// against BRAIN_SERVICE_SECRET (set in the Convex dashboard / `npx convex env
// set`). Clients never call Convex directly in the MVP.
import { ConvexError, v } from "convex/values";

export const secretArg = { secret: v.string() };

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function assertService(secret: string): void {
  const expected = process.env.BRAIN_SERVICE_SECRET;
  if (!expected || expected.length < 32 || !constantTimeEqual(secret, expected)) {
    throw new ConvexError({ code: "unauthorized" });
  }
}
