// Everything the app can change, an AI app can change for its user ("Agents first"): computers,
// teams and their people, the person's name and about you, where work sessions go, and what
// get_settings shows of them. Through the MCP tools, against the same rules as the app's routes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

type Call = { isError?: boolean; structuredContent?: Record<string, unknown> };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let lenaMcp: Awaited<ReturnType<typeof mcpClient>>;
let benMcp: Awaited<ReturnType<typeof mcpClient>>;
let slug: string;

/** A personal token for an AI app with every scope (as an AI app that connected with write access). */
const tokenFor = async (who: AppSession) =>
  (await s.pats.create({ uid: who.user.uid, scopes: ["personal:read", "personal:write", "team:read", "team:write"], resource: { kind: "personal" }, label: "Claude" })).token;
const call = async (mcp: typeof lenaMcp, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return { text: text(r), ...(r as Call) };
};

beforeAll(async () => {
  delete process.env.BRAIN_TEAM_POOL;
  s = await startStack();
  lena = await signIn(s, "apple-lena-account", "Lena Vogel");
  ben = await signIn(s, "apple-ben-account", "Ben Weiss");
  lenaMcp = await mcpClient(`${s.origin}/mcp`, await tokenFor(lena));
  benMcp = await mcpClient(`${s.origin}/mcp`, await tokenFor(ben));
});
afterAll(() => s.close());

describe("the account tools", () => {
  it("are there for a person's own connection", async () => {
    const tools = (await lenaMcp.listTools()).tools.map((t) => t.name);
    for (const t of ["connect_computer", "remove_computer", "create_team", "join_team", "team_people", "update_profile", "set_session_rules", "connect_microsoft"]) expect(tools).toContain(t);
  });

  it("change the name and about you, and get_settings shows them", async () => {
    const r = await call(lenaMcp, "update_profile", { name: "Lena Vogel-Berg", about: "I run product at a small logistics startup." });
    expect(r.text).toBe("Changed name: Lena Vogel-Berg and about you.");
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/me/about")).json.about).toBe("I run product at a small logistics startup.");
    const settings = await call(lenaMcp, "get_settings");
    expect(settings.text).toContain("- Name: Lena Vogel-Berg");
    expect(settings.text).toContain('"I run product at a small logistics startup."');
    expect(settings.text).toContain("Keeping the brain current: off");
    expect(settings.text).toContain("Computers: none connected");
  });
});

describe("computers", () => {
  it("connect with the one-line command, show in get_settings, and go when asked", async () => {
    const r = await call(lenaMcp, "connect_computer", { name: "Build server" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("/install.sh | sudo bash -s");
    const code = String(r.structuredContent!.commands).split(" ").pop()!;
    await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info: { hostname: "vps", os: "Linux", runner: "0.12.0", claude: "2.1" } }) });
    expect((await call(lenaMcp, "get_settings")).text).toMatch(/- Build server \(yours, id [^,]+, vps\): (online|offline)/);
    expect((await call(lenaMcp, "remove_computer", { computer: "Nope" })).isError).toBe(true);
    expect((await call(lenaMcp, "remove_computer", { computer: "build server" })).text).toContain("Removed Build server.");
    expect((await call(lenaMcp, "get_settings")).text).toContain("Computers: none connected");
  });
});

describe("teams", () => {
  it("are created on a computer of their own, joined with a code, and their people listed", async () => {
    const made = await call(lenaMcp, "create_team", { name: "Rowing Club" });
    expect(made.text).toContain("It runs on a computer of its own");
    slug = String((made.structuredContent!.team as { slug: string }).slug);
    expect((made.structuredContent!.team as { server: string }).server).toBe("none");

    // A member can't invite; the owner can.
    const invite = await call(lenaMcp, "team_people", { team: slug, action: "invite", uses: 2 });
    expect(invite.text).toMatch(/Invite code for .+: [A-Z0-9]+-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    const code = String(invite.structuredContent!.code);
    expect((await call(benMcp, "join_team", { code: "NOPE-0000-0000" })).isError).toBe(true);
    expect((await call(benMcp, "join_team", { code: `${s.origin}/join/${code}` })).text).toContain("Joined Rowing Club as a member");

    const list = await call(benMcp, "team_people", { team: slug, action: "list" });
    expect(list.text).toContain("Lena Vogel-Berg (owner");
    expect(list.text).toContain("Ben Weiss (member");
    // The same answer as the app's route.
    const route = await appCall(s, ben.access_token, "GET", `/v1/app/teams/${slug}/members`);
    expect(list.structuredContent).toEqual(route.json);
  });

  it("let only owners and admins invite, change roles and remove people", async () => {
    // Ben joined after the token was made: a new connection sees the team.
    benMcp = await mcpClient(`${s.origin}/mcp`, await tokenFor(ben));
    expect((await call(benMcp, "team_people", { team: slug, action: "invite" })).text).toContain("Only the team's owner and admins can do that.");
    expect((await call(benMcp, "team_people", { team: slug, action: "set_role", person: "Lena Vogel-Berg", role: "member" })).text).toContain("Only the team's owner and admins can do that.");
    expect((await call(benMcp, "team_people", { team: slug, action: "remove", person: "Lena Vogel-Berg" })).text).toContain("Only the team's owner and admins can do that.");

    lenaMcp = await mcpClient(`${s.origin}/mcp`, await tokenFor(lena));
    expect((await call(lenaMcp, "team_people", { team: slug, action: "set_role", person: "Ben Weiss", role: "admin" })).text).toContain("Ben Weiss is an admin");
    expect((await call(lenaMcp, "team_people", { team: slug, action: "set_role", person: "Ben Weiss", role: "member" })).text).toContain("a member");
    expect((await call(lenaMcp, "team_people", { team: slug, action: "leave" })).text).toContain("You own this team.");
    expect((await call(lenaMcp, "team_people", { team: slug, action: "remove", person: "Ben Weiss" })).text).toContain("Removed Ben Weiss");
    expect((await appCall(s, ben.access_token, "GET", "/v1/app/me")).json.teams).toEqual([]);
  });

  it("route work sessions to a team by folder, and connect the team's computer", async () => {
    expect((await call(lenaMcp, "set_session_rules", { rules: [{ match: "~/git/club", team: "nope" }] })).text).toContain('You\'re not in the team "nope".');
    const set = await call(lenaMcp, "set_session_rules", { rules: [{ match: "~/git/club", team: "Rowing Club" }] });
    expect(set.text).toBe(`Work sessions now go: ~/git/club → ${slug}; the rest stay personal.`);
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/sessions")).json.rules).toEqual([{ match: "~/git/club", team: slug }]);
    expect((await call(lenaMcp, "get_settings")).text).toContain(`~/git/club → ${slug}`);

    const team = await call(lenaMcp, "connect_computer", { name: "Club box", team: slug });
    expect(team.text).toContain("/install.sh | sudo bash -s");
    expect((team.structuredContent!.computer as { team: string }).team).toBe(slug);
    // Microsoft 365 isn't set up on this server: the tool says so, as the app does.
    expect((await call(lenaMcp, "connect_microsoft", { team: slug })).text).toContain("no Microsoft app");
  });
});
