// Scheduled jobs.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// oidc-provider's expired rows (oauth.ts).
crons.hourly("sweep expired OAuth rows", { minuteUTC: 17 }, internal.oauth.sweepExpired, {});
// AI-app clients that registered but never connected (oauth.ts).
crons.hourly("sweep unused OAuth clients", { minuteUTC: 41 }, internal.oauth.sweepUnusedClients, {});

export default crons;
