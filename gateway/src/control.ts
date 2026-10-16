// The gateway's only door to Convex. Production passes a ConvexHttpClient;
// tests pass a convex-test instance (same query/mutation signature), so the
// gateway is tested against the real Convex functions.
import { api } from "@brain/control/api";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

type Args<F extends FunctionReference<"query" | "mutation">> = Omit<FunctionArgs<F>, "secret">;

export interface ConvexCaller {
  query<F extends FunctionReference<"query">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  mutation<F extends FunctionReference<"mutation">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
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
}

export { api };
