// The services Ambient offers by name (docs/bots.md, "MCP connections"): each one's own MCP
// server, so connecting it is one tap and a sign-in at the service, with no address to find. An
// entry is here when its server answers over Streamable HTTP and either needs no sign-in, offers
// MCP's OAuth with dynamic client registration and PKCE (checked against each server's public
// metadata, 2026-11-21), or takes a token the person makes at the service (`signIn: "key"`, with
// where to make it: GitHub, 2026-11-23). Services that want an app registered by hand first and
// take no personal token (Asana, HubSpot, Slack, Box) aren't here; anything else connects by its
// address.
//
// The app holds the logos, by `id`; a new entry shows with its initials until the app has one.

export type CatalogCategory = "work" | "customers" | "money" | "build" | "data" | "look-up";

export interface CatalogEntry {
  /** Stable, lowercase: the app's logo and a connection's `catalog` are keyed by it. */
  id: string;
  name: string;
  url: string;
  /** What a bot can do with it, in a few words. */
  about: string;
  category: CatalogCategory;
  /**
   * "oauth": a sign-in at the service's own page; "none": open to anyone; "key": a token the
   * person makes at the service and pastes (`key` says where and what).
   */
  signIn: "oauth" | "none" | "key";
  /** For "key": the page where the token is made, and what to give it, in a sentence. */
  key?: { url: string; help: string };
}

export const CATEGORIES: { id: CatalogCategory; name: string }[] = [
  { id: "work", name: "Work and docs" },
  { id: "customers", name: "Customers" },
  { id: "money", name: "Money" },
  { id: "build", name: "Building software" },
  { id: "data", name: "Product data" },
  { id: "look-up", name: "Looking things up" },
];

const e = (id: string, name: string, url: string, about: string, category: CatalogCategory, signIn: "oauth" | "none" = "oauth"): CatalogEntry => ({ id, name, url, about, category, signIn });
/** A service reached with a token the person makes there (its OAuth needs an app registered by hand). */
const k = (id: string, name: string, url: string, about: string, category: CatalogCategory, key: { url: string; help: string }): CatalogEntry => ({ id, name, url, about, category, signIn: "key", key });

export const CATALOG: CatalogEntry[] = [
  e("notion", "Notion", "https://mcp.notion.com/mcp", "Read, search and write pages and databases", "work"),
  e("atlassian", "Jira and Confluence", "https://mcp.atlassian.com/v1/mcp", "Issues, sprints and wiki pages", "work"),
  e("linear", "Linear", "https://mcp.linear.app/mcp", "Issues, projects and cycles", "work"),
  e("monday", "monday.com", "https://mcp.monday.com/mcp", "Boards, items and updates", "work"),
  e("clickup", "ClickUp", "https://mcp.clickup.com/mcp", "Tasks, lists and docs", "work"),
  e("airtable", "Airtable", "https://mcp.airtable.com/mcp", "Bases, tables and records", "work"),
  e("todoist", "Todoist", "https://ai.todoist.net/mcp", "Tasks and projects", "work"),
  e("shortcut", "Shortcut", "https://mcp.shortcut.com/mcp", "Stories, epics and iterations", "work"),
  e("miro", "Miro", "https://mcp.miro.com/", "Boards and what's on them", "work"),
  e("figma", "Figma", "https://mcp.figma.com/mcp", "Designs, components and comments", "work"),
  e("canva", "Canva", "https://mcp.canva.com/mcp", "Designs and brand templates", "work"),
  e("higgsfield", "Higgsfield", "https://mcp.higgsfield.ai/mcp", "AI images and videos from a prompt", "work"),
  e("dropbox", "Dropbox", "https://mcp.dropbox.com/mcp", "Files and folders", "work"),
  e("granola", "Granola", "https://mcp.granola.ai/mcp", "Meeting notes", "work"),
  e("fireflies", "Fireflies", "https://api.fireflies.ai/mcp", "Meeting transcripts and summaries", "work"),
  e("calcom", "Cal.com", "https://mcp.cal.com/mcp", "Bookings and availability", "work"),
  e("webflow", "Webflow", "https://mcp.webflow.com/mcp", "Sites, pages and CMS items", "work"),
  e("wix", "Wix", "https://mcp.wix.com/mcp", "Sites, content and store data", "work"),

  e("intercom", "Intercom", "https://mcp.intercom.com/mcp", "Conversations and contacts", "customers"),
  e("attio", "Attio", "https://mcp.attio.com/mcp", "People, companies and deals", "customers"),
  e("close", "Close", "https://mcp.close.com/mcp", "Leads, calls and pipeline", "customers"),

  e("stripe", "Stripe", "https://mcp.stripe.com", "Customers, payments and invoices", "money"),
  e("paypal", "PayPal", "https://mcp.paypal.com/mcp", "Payments, invoices and disputes", "money"),
  e("square", "Square", "https://mcp.squareup.com/mcp", "Orders, payments and catalog", "money"),
  e("ramp", "Ramp", "https://ramp-mcp-remote.ramp.com/mcp", "Spend, cards and bills", "money"),

  // GitHub's own MCP server: its OAuth takes no clients registered on the fly, a personal token works.
  k("github", "GitHub", "https://api.githubcopilot.com/mcp/", "Repos, issues and pull requests", "build", {
    url: "https://github.com/settings/personal-access-tokens/new",
    help: "A fine-grained token for the repos it may work on, with Contents, Issues and Pull requests set to read and write (read only if it should only look).",
  }),
  e("sentry", "Sentry", "https://mcp.sentry.dev/mcp", "Errors, issues and releases", "build"),
  e("vercel", "Vercel", "https://mcp.vercel.com", "Projects, deployments and logs", "build"),
  e("netlify", "Netlify", "https://netlify-mcp.netlify.app/mcp", "Sites, deploys and forms", "build"),
  e("gitlab", "GitLab", "https://gitlab.com/api/v4/mcp", "Projects, merge requests and pipelines", "build"),
  e("buildkite", "Buildkite", "https://mcp.buildkite.com/mcp", "Pipelines, builds and logs", "build"),
  e("supabase", "Supabase", "https://mcp.supabase.com/mcp", "Projects, tables and logs", "build"),
  e("neon", "Neon", "https://mcp.neon.tech/mcp", "Postgres projects and branches", "build"),
  e("planetscale", "PlanetScale", "https://mcp.pscale.dev/mcp/planetscale", "Databases, branches and insights", "build"),
  e("cloudflare", "Cloudflare", "https://observability.mcp.cloudflare.com/mcp", "Workers logs and analytics", "build"),
  e("datadog", "Datadog", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", "Logs, metrics and monitors", "build"),
  e("grafana", "Grafana", "https://mcp.grafana.com/mcp", "Dashboards, alerts and queries", "build"),
  e("jam", "Jam", "https://mcp.jam.dev/mcp", "Bug reports with their recordings", "build"),
  e("resend", "Resend", "https://mcp.resend.com/mcp", "Emails, domains and audiences", "build"),
  e("apify", "Apify", "https://mcp.apify.com", "Web scrapers and their results", "build"),

  e("posthog", "PostHog", "https://mcp.posthog.com/mcp", "Events, insights and feature flags", "data"),
  e("mixpanel", "Mixpanel", "https://mcp.mixpanel.com/mcp", "Events, funnels and retention", "data"),
  e("amplitude", "Amplitude", "https://mcp.amplitude.com/mcp", "Charts, cohorts and experiments", "data"),

  e("context7", "Context7", "https://mcp.context7.com/mcp", "Current docs for code libraries", "look-up", "none"),
  e("deepwiki", "DeepWiki", "https://mcp.deepwiki.com/mcp", "Questions about public GitHub repos", "look-up", "none"),
  e("huggingface", "Hugging Face", "https://huggingface.co/mcp", "Models, datasets and papers", "look-up", "none"),
];
