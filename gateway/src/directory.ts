// Who exists and who belongs to which team, read from Convex behind a short
// cache. A removed member loses access within `ttlMs` (60 s in production).
import { api, type Control } from "./control.ts";

export type Role = "owner" | "admin" | "member";

export interface User {
  uid: string;
  name: string;
  email: string | null;
}

export interface Team {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "canceled";
  serverUrl: string | null;
  role?: Role | null;
  peopleSlug?: string | null;
}

export class Directory {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private control: Control,
    private ttlMs = 60_000,
  ) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const value = await load();
    if (this.ttlMs > 0) this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 10_000) this.cache.clear();
    return value;
  }

  invalidate(uid: string): void {
    this.cache.delete(`user:${uid}`);
    this.cache.delete(`teams:${uid}`);
  }

  async user(uid: string): Promise<User | undefined> {
    const u = await this.cached(`user:${uid}`, () => this.control.q(api.users.get, { uid }));
    return u ? { uid: u.uid, name: u.name, email: u.email } : undefined;
  }

  async teamsOf(uid: string): Promise<Team[]> {
    return this.cached(`teams:${uid}`, () => this.control.q(api.teams.ofUser, { uid })) as Promise<Team[]>;
  }

  async teamBySlug(slug: string): Promise<Team | undefined> {
    const t = await this.cached(`team:${slug}`, () => this.control.q(api.teams.bySlug, { slug }));
    return (t ?? undefined) as Team | undefined;
  }

  async membership(uid: string, slug: string): Promise<Team | undefined> {
    return (await this.teamsOf(uid)).find((t) => t.slug === slug);
  }
}
