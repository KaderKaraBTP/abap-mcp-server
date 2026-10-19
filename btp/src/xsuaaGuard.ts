/**
 * Who may call the MCP endpoint: a bearer token of the application's XSUAA
 * instance that carries the `MCPUser` scope (user tokens get it through a
 * role collection, technical clients through `authorities`).
 *
 * A request without a valid token is answered `401` with
 * `WWW-Authenticate: Bearer resource_metadata=…`, which is how an MCP client
 * finds the authorization server (RFC 9728, MCP authorization spec).
 *
 * The request runs inside `runAsUser`: a user token is kept for principal
 * propagation and user-dependent destinations; a client-credentials token is
 * not a user and is not propagated.
 */

import { XsuaaService } from '@sap/xssec';
import type { NextFunction, Request, Response } from 'express';
import { runAsUser } from './requestUser';
import type { XsuaaCredentials } from './vcap';

export interface GuardOptions {
  credentials: XsuaaCredentials;
  /** The local scope a caller needs. */
  scope: string;
  /** Where the protected resource metadata is served. */
  resourceMetadataUrl: string;
}

export function xsuaaGuard(options: GuardOptions) {
  const service = new XsuaaService(options.credentials);
  const challenge = (error?: string) =>
    `Bearer resource_metadata="${options.resourceMetadataUrl}"${
      error ? `, error="${error}"` : ''
    }`;

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const jwt = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!jwt) {
      res.setHeader('WWW-Authenticate', challenge());
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    let context: Awaited<ReturnType<XsuaaService['createSecurityContext']>>;
    try {
      context = await service.createSecurityContext(jwt);
    } catch {
      res.setHeader('WWW-Authenticate', challenge('invalid_token'));
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const scoped = context as unknown as {
      checkLocalScope(scope: string): boolean;
    };
    if (!scoped.checkLocalScope(options.scope)) {
      res.setHeader('WWW-Authenticate', challenge('insufficient_scope'));
      res.status(403).json({ error: 'insufficient_scope' });
      return;
    }
    const isUser = context.getGrantType() !== 'client_credentials';
    // The SAP connection is built from the destination, never from what the
    // caller sends: direct-connection headers are not honoured here.
    for (const name of Object.keys(req.headers)) {
      if (name.toLowerCase().startsWith('x-sap-')) {
        if (
          !['x-sap-language', 'x-sap-responsible', 'x-sap-master-system'].includes(
            name.toLowerCase(),
          )
        ) {
          delete req.headers[name];
        }
      }
    }
    runAsUser({ userJwt: isUser ? jwt : undefined }, next);
  };
}

/** The protected resource metadata (RFC 9728) for the MCP endpoint. */
export function protectedResourceMetadata(
  resource: string,
  credentials: XsuaaCredentials,
  scope: string,
) {
  return {
    resource,
    authorization_servers: [credentials.url],
    bearer_methods_supported: ['header'],
    scopes_supported: [`${credentials.xsappname}.${scope}`],
    resource_name: 'SAP ABAP ADT MCP server',
  };
}
