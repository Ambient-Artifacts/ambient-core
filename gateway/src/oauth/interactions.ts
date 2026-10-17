// Login and consent pages for the authorization server, served on the same
// origin as /oauth/* so oidc-provider's interaction cookies just work.
// AI apps: login = a pairing code from the Ambient app (Settings → Connect an AI
// app), then a consent page.
// The Ambient apps (APP_CLIENT_ID) skip both pages: they send Sign in with Apple's
// or Microsoft's ID token to /interaction/:uid/apple or /microsoft, which signs
// them in and grants the app API at once. No other client can use those steps,
// and the apps can't use the pairing code.
//
// Guessing a code is held back three ways: codes are 8 characters from 32 (about 10^12
// possibilities, PAIRING_CODE_LENGTH), a sign-in allows 5 wrong codes, and an address allows
// 10 wrong codes per 10 minutes, however many sign-ins it starts. Starting sign-ins costs
// nothing (clients register themselves), so before that last limit a script could keep
// guessing a live code until it hit one.
import { ConvexError } from "convex/values";
import express, { type Request, type Response, type Router } from "express";
import type Provider from "oidc-provider";
import { z } from "zod";
import type { AppleVerifier } from "../auth/apple.ts";
import type { MicrosoftVerifier } from "../auth/microsoft.ts";
import type { Pairing } from "../auth/pairing.ts";
import { api, type Control } from "../control.ts";
import type { Directory } from "../directory.ts";
import { limiter, strikes } from "../limiter.ts";
import { consentPage, errorPage, esc, loginPage, type LoginCodes } from "./pages.ts";
import { APP_CLIENT_ID, appResource, parseResource } from "./provider.ts";

/** How the apps sign in (verifiers), each from the gateway's config. */
export interface AppSignIn {
  apple: AppleVerifier;
  /** Only when the gateway has a Microsoft app registration. */
  microsoft?: MicrosoftVerifier;
  /** Where sign-in codes come from: the app (default), the admin CLI, or either. */
  codes?: LoginCodes;
  /** Who may make a new account from the apps (config.signups); absent: anyone. */
  signups?: { allow: string[] };
}

/** Convex refused a new account: the server's sign-ups aren't open to this person. */
function isNotInvited(err: unknown): boolean {
  return err instanceof ConvexError && (err.data as { code?: string } | undefined)?.code === "not_invited";
}

/**
 * Why a new account was refused on a server whose sign-ups aren't open, for the app to show. It
 * names the email Apple gave, even a "Hide My Email" relay address: that one is stable and
 * verified too, and Apple won't ask again which to share, so the admin adds it as it is.
 */
function notInvited(email: string | undefined): string {
  return email
    ? `This server only lets in people its admin added. Ask them to add ${email}.`
    : "This server only lets in people its admin added. Ask them to add you.";
}

const AppleBody = z.object({ identityToken: z.string().min(20).max(5000), name: z.string().max(80).optional() });
const MicrosoftBody = z.object({
  idToken: z.string().min(20).max(10_000),
  nonce: z.string().min(8).max(200).optional(),
  name: z.string().max(80).optional(),
});

const MAX_ATTEMPTS = 5;
/** Wrong codes from one address before it has to wait. */
const MAX_WRONG_PER_ADDRESS = 10;
const ADDRESS_WINDOW_MS = 10 * 60_000;
/** A sign-in (oidc-provider's interaction) lives an hour; its count no longer matters after. */
const INTERACTION_MS = 3_600_000;

const SCOPE_TEXT: Record<string, string> = {
  "personal:read": "Read your personal notes and wiki",
  "personal:write": "Save notes into your personal wiki, and draft loops that run only once you turn them on in the app",
  "team:read": "Read the team wikis you belong to",
  "team:write": "Log finished work to your team's wiki (after a 30-minute hold you can undo in the app), and draft team loops that run only once someone turns them on in the app",
  "team:review": "See and act on team review items",
  offline_access: "Stay connected without signing in again",
  openid: "Know who you are",
};

export function interactionRouter(provider: Provider, directory: Directory, pairing: Pairing, control: Control, app: AppSignIn): Router {
  const router = express.Router();
  const attempts = strikes(MAX_ATTEMPTS, INTERACTION_MS);
  const wrongFrom = strikes(MAX_WRONG_PER_ADDRESS, ADDRESS_WINDOW_MS);
  const appSignIns = limiter(30);

  router.use("/interaction", express.urlencoded({ extended: false }));
  router.use("/interaction", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    // No form-action: the post-consent redirect chain ends at the client's
    // callback, which can be any origin or a custom scheme.
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
    next();
  });

  const loginForm = (uid: string, clientName: string, redirectHost: string, error?: string) =>
    loginPage({ uid, clientName, redirectHost, error, codes: app.codes });

  router.get("/interaction/:uid", async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.params.client_id === APP_CLIENT_ID) {
        res.status(400).send(errorPage({ message: "Sign in from the Ambient app." }));
        return;
      }
      const client = await provider.Client.find(String(details.params.client_id));
      const clientName = String(client?.clientName ?? details.params.client_id);
      const redirectHost = shownHost(String(details.params.redirect_uri));

      if (details.prompt.name === "login") {
        res.send(loginForm(details.uid, clientName, redirectHost));
        return;
      }

      const missing = details.prompt.details as { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> };
      const scopes = new Set<string>([...(missing.missingOIDCScope ?? []), ...Object.values(missing.missingResourceScopes ?? {}).flat()]);
      const teamLines: string[] = [];
      for (const r of Object.keys(missing.missingResourceScopes ?? {})) {
        const parsed = parseResource(provider.issuer, r);
        if (!parsed?.teamSlug) continue;
        const team = await directory.teamBySlug(parsed.teamSlug);
        teamLines.push(`Only the <b>${esc(team?.name ?? parsed.teamSlug)}</b> team wiki (not your personal notes)`);
      }
      // Whose notes: so nobody approves an app for an account that isn't theirs (a shared browser).
      const who = details.session?.accountId ? await directory.user(details.session.accountId) : undefined;
      res.send(
        consentPage({
          uid: details.uid,
          clientName,
          redirectHost,
          account: who ? (who.email ? `${who.name} (${who.email})` : who.name) : undefined,
          permissionsHtml: [...[...scopes].map((sc) => esc(SCOPE_TEXT[sc] ?? sc)), ...teamLines],
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/login", async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== "login" || details.params.client_id === APP_CLIENT_ID) {
        res.status(400).send(errorPage({ message: "This sign-in step was unexpected or has expired." }));
        return;
      }
      if (attempts.blocked(details.uid)) {
        await provider.interactionFinished(req, res, { error: "access_denied", error_description: "too many wrong codes" }, { mergeWithLastSubmission: false });
        return;
      }
      const address = req.ip ?? "unknown";
      const form = async (status: number, error: string) => {
        const client = await provider.Client.find(String(details.params.client_id));
        res.status(status).send(loginForm(details.uid, String(client?.clientName ?? details.params.client_id), shownHost(String(details.params.redirect_uri)), error));
      };
      // Checked before the code is even looked at: from here, the right code waits too.
      if (wrongFrom.blocked(address)) {
        await form(429, "Too many wrong codes from here. Wait 10 minutes, then try again with a new code.");
        return;
      }
      const uid = await pairing.consume(String(req.body?.code ?? ""));
      if (!uid || !(await directory.user(uid))) {
        attempts.add(details.uid);
        wrongFrom.add(address);
        await form(401, attempts.blocked(details.uid) ? "That code didn't work either. Start again from your AI app." : "That code didn't work. Codes expire after 5 minutes and work once.");
        return;
      }
      attempts.clear(details.uid);
      // Not remembered: the browser keeps no sign-in once it closes, so a page that later sends it
      // to /oauth/authorize for some other app can't skip the code and go straight to "Allow".
      await provider.interactionFinished(req, res, { login: { accountId: uid, remember: false } }, { mergeWithLastSubmission: false });
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/confirm", async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== "consent" || !details.session?.accountId || details.params.client_id === APP_CLIENT_ID) {
        res.status(400).send(errorPage({ message: "This sign-in step was unexpected or has expired." }));
        return;
      }
      const accountId = details.session.accountId;
      const missing = details.prompt.details as { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> };

      // A team-pinned resource is only grantable to members of that team.
      for (const resource of Object.keys(missing.missingResourceScopes ?? {})) {
        const r = parseResource(provider.issuer, resource);
        if (r?.teamSlug && !(await directory.membership(accountId, r.teamSlug))) {
          await provider.interactionFinished(req, res, { error: "access_denied", error_description: "not a member of this team" }, { mergeWithLastSubmission: false });
          return;
        }
      }

      const grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({ accountId, clientId: String(details.params.client_id) });
      if (!grant) throw new Error("grant vanished");
      if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) grant.addResourceScope(resource, scopes.join(" "));
      const grantId = await grant.save();
      await control.m(api.users.markAppConnected, { uid: accountId as never, now: Date.now() });
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- the Ambient apps ----

  /**
   * Signs the app in as `accountId` and grants it the app API, answering with the address that
   * hands out the authorization code (the app follows it itself, then trades the code for
   * DPoP-bound tokens at /oauth/token like any client).
   */
  const finishAppSignIn = async (req: Request, res: Response, accountId: string) => {
    const grant = new provider.Grant({ accountId, clientId: APP_CLIENT_ID });
    grant.addResourceScope(appResource(provider.issuer), "app");
    const grantId = await grant.save();
    const next = await provider.interactionResult(req, res, { login: { accountId }, consent: { grantId } }, { mergeWithLastSubmission: false });
    res.json({ next });
  };

  /** The interaction, when it's the app's and waiting for a sign-in; otherwise answered here. */
  const appInteraction = async (req: Request, res: Response) => {
    if (!appSignIns(req.ip ?? "?")) {
      res.status(429).json({ error: "slow_down" });
      return null;
    }
    const details = await provider.interactionDetails(req, res);
    if (details.params.client_id !== APP_CLIENT_ID || details.prompt.name !== "login") {
      res.status(400).json({ error: "unexpected_step" });
      return null;
    }
    return details;
  };

  const appJson = express.json({ limit: "32kb" });

  router.post("/interaction/:uid/apple", appJson, async (req, res, next) => {
    try {
      if (!(await appInteraction(req, res))) return;
      const body = AppleBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      let identity;
      try {
        identity = await app.apple(body.data.identityToken);
      } catch (err) {
        // The reason only (e.g. an unexpected "aud" = wrong bundle id), never the token.
        console.warn(`[gateway] apple sign-in rejected: ${(err as Error).message}`);
        res.status(401).json({ error: "invalid_apple_token" });
        return;
      }
      let user;
      try {
        user = await control.m(api.users.upsertApple, {
          appleSub: identity.sub,
          email: identity.email,
          emailVerified: identity.emailVerified,
          name: body.data.name,
          signups: app.signups,
          now: Date.now(),
        });
      } catch (err) {
        if (!isNotInvited(err)) throw err;
        res.status(403).json({ error: "not_invited", message: notInvited(identity.emailVerified ? identity.email : undefined) });
        return;
      }
      if (!user) {
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      await finishAppSignIn(req, res, String(user.uid));
    } catch (err) {
      next(err);
    }
  });

  // A separate account from an Apple sign-in of the same person (not joined by email).
  router.post("/interaction/:uid/microsoft", appJson, async (req, res, next) => {
    try {
      if (!app.microsoft) {
        res.status(404).json({ error: "microsoft_not_configured" });
        return;
      }
      if (!(await appInteraction(req, res))) return;
      const body = MicrosoftBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      let identity;
      try {
        identity = await app.microsoft(body.data.idToken, body.data.nonce);
      } catch (err) {
        // The reason only (a wrong audience or tenant), never the token.
        console.warn(`[gateway] microsoft sign-in rejected: ${(err as Error).message}`);
        res.status(401).json({ error: "invalid_microsoft_token" });
        return;
      }
      let user;
      try {
        user = await control.m(api.users.upsertMicrosoft, { microsoftId: identity.id, email: identity.email, name: identity.name ?? body.data.name, signups: app.signups, now: Date.now() });
      } catch (err) {
        if (!isNotInvited(err)) throw err;
        res.status(403).json({ error: "not_invited", message: notInvited(undefined) });
        return;
      }
      if (!user) {
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      await finishAppSignIn(req, res, String(user.uid));
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/abort", async (req, res, next) => {
    try {
      await provider.interactionFinished(req, res, { error: "access_denied", error_description: "user cancelled" }, { mergeWithLastSubmission: false });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Where an AI app's code goes back to, as the sign-in pages show it. An https address names a host
 * its owner proves, and http only ever goes to this computer (localhost); a native app's custom
 * scheme (`x-app://claude.ai/…`) could claim any host, so it shows as its scheme and never gets a
 * known app's icon or name.
 */
function shownHost(redirectUri: string): string {
  const u = new URL(redirectUri);
  const loopback = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  return u.protocol === "https:" || loopback ? u.host : u.protocol.replace(/:$/, "");
}
