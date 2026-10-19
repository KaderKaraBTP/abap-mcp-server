/**
 * Reads a destination from the SAP BTP Destination service.
 *
 * "Find a destination" (`/destination-configuration/v1/destinations/<name>`)
 * answers the configuration and, for the OAuth/SAML authentication types,
 * ready-made `authTokens`. User-dependent types need the user's token, sent
 * as `X-user-token`; it is sent whenever the request has one.
 *
 * A lookup is kept for `DESTINATION_CACHE_SECONDS` (default 300), and never
 * past the earliest expiry of a token it carries.
 */

import { createHash } from 'node:crypto';
import axios from 'axios';
import { clientCredentialsToken, forgetTokens } from './oauth';
import type { DestinationCredentials } from './vcap';

export interface DestinationConfiguration {
  Name: string;
  URL: string;
  Type?: string;
  ProxyType?: 'Internet' | 'OnPremise' | string;
  Authentication?: string;
  User?: string;
  Password?: string;
  CloudConnectorLocationId?: string;
  'sap-client'?: string;
  [property: string]: string | undefined;
}

export interface DestinationAuthToken {
  type: string;
  value: string;
  expires_in?: string;
  error?: string;
  http_header?: { key: string; value: string };
}

export interface Destination {
  configuration: DestinationConfiguration;
  authTokens: DestinationAuthToken[];
}

interface Cached {
  destination: Destination;
  expiresAt: number;
}

export class DestinationService {
  private readonly cache = new Map<string, Cached>();
  private readonly ttlMs: number;

  constructor(
    private readonly credentials: DestinationCredentials,
    ttlSeconds = Number(process.env.DESTINATION_CACHE_SECONDS ?? 300),
  ) {
    this.ttlMs = (Number.isFinite(ttlSeconds) ? ttlSeconds : 300) * 1000;
  }

  async find(name: string, userJwt?: string): Promise<Destination> {
    const key = this.keyOf(name, userJwt);
    const held = this.cache.get(key);
    if (held && held.expiresAt > Date.now()) return held.destination;

    const token = await clientCredentialsToken(this.credentials);
    const url = `${this.credentials.uri.replace(/\/+$/, '')}/destination-configuration/v1/destinations/${encodeURIComponent(name)}`;
    let data: {
      destinationConfiguration?: DestinationConfiguration;
      authTokens?: DestinationAuthToken[];
    };
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(userJwt ? { 'X-user-token': userJwt } : {}),
        },
        proxy: false,
      });
      data = response.data;
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response
        ?.status;
      if (status === 401) forgetTokens(this.credentials);
      if (status === 404) {
        throw new Error(
          `BTP destination "${name}" was not found in the subaccount or the space.`,
        );
      }
      throw new Error(
        `BTP Destination service did not answer for "${name}" (${status ?? 'no response'}).`,
      );
    }
    if (!data.destinationConfiguration?.URL) {
      throw new Error(`BTP destination "${name}" has no URL.`);
    }

    const destination: Destination = {
      configuration: data.destinationConfiguration,
      authTokens: data.authTokens ?? [],
    };
    const tokenExpiry = destination.authTokens
      .map((t) => Number(t.expires_in))
      .filter((s) => Number.isFinite(s) && s > 0)
      .map((s) => s * 1000 - 60_000);
    this.cache.set(key, {
      destination,
      expiresAt: Date.now() + Math.min(this.ttlMs, ...tokenExpiry),
    });
    return destination;
  }

  /** Drops what is held for a destination: its credential was refused. */
  forget(name: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${name}|`)) this.cache.delete(key);
    }
  }

  private keyOf(name: string, userJwt?: string): string {
    const user = userJwt
      ? createHash('sha256').update(userJwt).digest('hex')
      : '-';
    return `${name}|${user}`;
  }
}
