/**
 * Who the current MCP request is from: the inbound XSUAA token when it names
 * a user, nothing for a technical client (client credentials).
 *
 * Kept in an AsyncLocalStorage the auth middleware opens around the request,
 * so a credential presented deep in a tool call reads the user of the request
 * that made the call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestUser {
  /** The user's own token, for principal propagation and user-dependent destinations. */
  userJwt?: string;
}

const storage = new AsyncLocalStorage<RequestUser>();

export function runAsUser<T>(user: RequestUser, fn: () => T): T {
  return storage.run(user, fn);
}

export function currentUser(): RequestUser {
  return storage.getStore() ?? {};
}
