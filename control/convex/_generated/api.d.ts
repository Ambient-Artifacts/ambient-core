/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as lib_service from "../lib/service.js";
import type * as oauth from "../oauth.js";
import type * as personal from "../personal.js";
import type * as push from "../push.js";
import type * as repos from "../repos.js";
import type * as revisions from "../revisions.js";
import type * as routines from "../routines.js";
import type * as sessions from "../sessions.js";
import type * as teams from "../teams.js";
import type * as users from "../users.js";
import type * as work from "../work.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  crons: typeof crons;
  "lib/service": typeof lib_service;
  oauth: typeof oauth;
  personal: typeof personal;
  push: typeof push;
  repos: typeof repos;
  revisions: typeof revisions;
  routines: typeof routines;
  sessions: typeof sessions;
  teams: typeof teams;
  users: typeof users;
  work: typeof work;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
