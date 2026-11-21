// The gateway's only door to Convex. Production passes a ConvexHttpClient;
// tests pass a convex-test instance (same query/mutation signature), so the
// gateway is tested against the real Convex functions.
import { api } from "@brain/control/api";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

type Args<F extends FunctionReference<"query" | "mutation" | "action">> = Omit<FunctionArgs<F>, "secret">;

export interface ConvexCaller {
  query<F extends FunctionReference<"query">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  mutation<F extends FunctionReference<"mutation">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  /** Actions (file storage: attachments). Optional: callers without it can't store files. */
  action?<F extends FunctionReference<"action">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
}

export class Control {
  constructor(
    private caller: ConvexCaller,
    private secret: string,
  ) {}

  q<F extends FunctionReference<"query">>(fn: F, args: Args<F>): Promise<FunctionReturnType<F>> {
    return this.caller.query(fn, { ...args, secret: this.secret } as FunctionArgs<F>);
  }

  m<F extends FunctionReference<"mutation">>(fn: F, args: Args<F>): Promise<FunctionReturnType<F>> {
    return this.caller.mutation(fn, { ...args, secret: this.secret } as FunctionArgs<F>);
  }

  a<F extends FunctionReference<"action">>(fn: F, args: Args<F>): Promise<FunctionReturnType<F>> {
    if (!this.caller.action) throw new Error("this Convex connection can't run actions");
    return this.caller.action(fn, { ...args, secret: this.secret } as FunctionArgs<F>);
  }
}

export { api };
