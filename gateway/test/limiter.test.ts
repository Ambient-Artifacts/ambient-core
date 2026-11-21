// The in-process limits: per-address keys and requests in flight.
import { describe, expect, it } from "vitest";
import { addressKey, inFlight } from "../src/limiter.ts";

describe("limits", () => {
  it("key an IPv6 address by its /64, an IPv4 one as is", () => {
    expect(addressKey("2001:db8:abcd:12:1::5")).toBe(addressKey("2001:db8:abcd:0012:ffff::1"));
    expect(addressKey("2001:db8:abcd:13::1")).not.toBe(addressKey("2001:db8:abcd:12::1"));
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey(undefined)).toBe("unknown");
  });

  it("let a key have only so many requests going at once, and free a slot when one ends", () => {
    const slots = inFlight(2);
    const a = slots("u1")!;
    const b = slots("u1")!;
    expect(slots("u1")).toBeNull();
    expect(slots("u2")).not.toBeNull();
    a();
    a(); // released twice: still one slot
    const c = slots("u1");
    expect(c).not.toBeNull();
    expect(slots("u1")).toBeNull();
    b();
    c!();
  });
});
