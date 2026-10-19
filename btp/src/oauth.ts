/**
 * Tokens from a subaccount's UAA for the Destination and Connectivity
 * services: client credentials for the service itself, and the JWT bearer
 * exchange that carries a user's identity (principal propagation).
 *
 * Each token is kept until a minute before it expires; a user's exchanged
 * token is kept under a hash of the user's own token, never the token itself.
 */

import { createHash } from 'node:crypto';
import axios from 'axios';
import type { OAuthClientCredentials } from './vcap';

interface Cached {
  token: string;
  expiresAt: number;
}

const MARGIN_MS = 60_000;
const cache = new Map<string, Cached>();

function tokenUrl(credentials: OAuthClientCredentials): string {
  const base = credentials.token_service_url ?? credentials.url;
  return `${base.replace(/\/+$/, '')}/oauth/token`;
}

function keyOf(credentials: OAuthClientCredentials, assertion?: string): string {
  const user = assertion
    ? createHash('sha256').update(assertion).digest('hex')
    : '-';
  return `${credentials.clientid}|${user}`;
}

async function fetchToken(
  credentials: OAuthClientCredentials,
  form: Record<string, string>,
  key: string,
): Promise<string> {
  const held = cache.get(key);
  if (held && held.expiresAt > Date.now()) return held.token;

  const response = await axios.post(
    tokenUrl(credentials),
    new URLSearchParams({ ...form, client_id: credentials.clientid }).toString(),
    {
      auth: {
        username: credentials.clientid,
        password: credentials.clientsecret,
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      // Never through a proxy the environment may name.
      proxy: false,
    },
  );
  const { access_token, expires_in } = response.data as {
    access_token: string;
    expires_in?: number;
  };
  const lifetime = (expires_in ?? 600) * 1000;
  cache.set(key, {
    token: access_token,
    expiresAt: Date.now() + Math.max(lifetime - MARGIN_MS, 0),
  });
  return access_token;
}

/** A client-credentials token of the service the credentials belong to. */
export function clientCredentialsToken(
  credentials: OAuthClientCredentials,
): Promise<string> {
  return fetchToken(
    credentials,
    { grant_type: 'client_credentials' },
    keyOf(credentials),
  );
}

/** The user's token exchanged for one of this service (JWT bearer grant). */
export function jwtBearerToken(
  credentials: OAuthClientCredentials,
  userJwt: string,
): Promise<string> {
  return fetchToken(
    credentials,
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: userJwt,
    },
    keyOf(credentials, userJwt),
  );
}

/** Forgets every token held for these credentials (after a 401). */
export function forgetTokens(credentials: OAuthClientCredentials): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${credentials.clientid}|`)) cache.delete(key);
  }
}
