// Scheduled jobs.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// oidc-provider's expired rows (oauth.ts).
crons.hourly("sweep expired OAuth rows", { minuteUTC: 17 }, internal.oauth.sweepExpired, {});

export default crons;
