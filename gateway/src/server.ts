// Gateway entry point (systemd: brain-gateway.service, behind Caddy on :443).
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { createApp, VERSION } from "./app.ts";
import { appleVerifier } from "./auth/apple.ts";
import { loadConfig } from "./config.ts";
import { ConvexRevisionSource } from "./revisions.ts";

const config = loadConfig();
const convex = new ConvexHttpClient(config.convexUrl);
// One WebSocket to Convex for the apps' live revisions (Node has WebSocket built in).
const live = new ConvexClient(config.convexUrl);
const { app } = createApp({
  config,
  convex: { query: (fn, args) => convex.query(fn, args), mutation: (fn, args) => convex.mutation(fn, args) },
  apple: appleVerifier(config.appleAudiences),
  revisionSource: new ConvexRevisionSource(live, config.serviceSecret),
});

const port = Number(process.env.PORT ?? 8080);
// Behind Caddy on the same machine by default; in a container, 0.0.0.0.
const host = process.env.BRAIN_LISTEN_HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`[gateway] brain-gateway ${VERSION} on ${host}:${port}, issuer ${config.origin}`);
  const signIn = [
    config.appleAudiences.length ? `Apple (${config.appleAudiences.join(", ")})` : null,
    config.microsoftClientIds?.length ? "Microsoft" : null,
    config.googleClientIds?.length ? "Google" : null,
  ].filter(Boolean);
  console.log(`[gateway] app sign-in: ${signIn.length ? signIn.join(", ") : "none (accounts and AI-app codes come from the admin CLI)"}`);
  // Unset BRAIN_SIGNUPS means open: say so, so a server meant to be private doesn't stay open unnoticed.
  if (signIn.length) {
    console.log(`[gateway] new accounts: ${config.signups ? `only people the admin added${config.signups.allow.length ? ` or ${config.signups.allow.join(", ")}` : ""}` : "anyone who signs in (BRAIN_SIGNUPS unset or open)"}`);
    console.log(`[gateway] sign-in nonces: ${config.requireSignInNonce ? "required" : "checked when the app sends one (BRAIN_SIGNIN_NONCE=required makes them mandatory)"}`);
  }
  console.log(`[gateway] push notifications ${config.apns ? `on (APNs key ${config.apns.keyId}, topic ${config.apns.topic})` : "off: no APNs key in the env"}`);
});
