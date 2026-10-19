/**
 * The credential of a BTP destination, presented per request.
 *
 * What goes on the request depends on the destination:
 *
 * - `BasicAuthentication` — `Authorization: Basic` from the destination's
 *   user and password;
 * - `PrincipalPropagation` (on premise) — no `Authorization`: the user's
 *   token, exchanged at the Connectivity service, is the proxy's credential
 *   and the Cloud Connector logs the user on;
 * - any type the Destination service answers `authTokens` for (OAuth2*,
 *   SAMLAssertion, …) — the token's own header;
 * - `NoAuthentication` — nothing.
 *
 * And for `ProxyType: OnPremise` — `Proxy-Authorization` for the
 * connectivity proxy, plus `SAP-Connectivity-SCC-Location_ID` when the
 * destination names a Cloud Connector location.
 *
 * The destination is read per request (cached by the service), so a changed
 * password in the cockpit is taken without a restart.
 */

import type {
  AuthOutcome,
  IAuthProvider,
  IAuthRejection,
  ILogonTarget,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type { Destination, DestinationService } from './destinationService';
import { clientCredentialsToken, forgetTokens, jwtBearerToken } from './oauth';
import { currentUser } from './requestUser';
import type { ConnectivityCredentials } from './vcap';

const ok: AuthOutcome = { ok: true };

function refuse(reason: string, hint?: string): AuthOutcome {
  return { ok: false, refusal: { reason, ...(hint ? { hint } : {}) } };
}

export class BtpDestinationAuthProvider implements IAuthProvider {
  readonly kind = 'btp-destination';
  private retried = false;

  constructor(
    private readonly name: string,
    private readonly destinations: DestinationService,
    private readonly connectivity: ConnectivityCredentials | undefined,
  ) {}

  async prepare(): Promise<AuthOutcome> {
    return ok;
  }

  async establish(_logon: ILogonTarget): Promise<AuthOutcome> {
    return ok;
  }

  async authorize(request: IRequestTarget): Promise<AuthOutcome> {
    const { userJwt } = currentUser();
    let destination: Destination;
    try {
      destination = await this.destinations.find(this.name, userJwt);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
    const config = destination.configuration;
    const onPremise = config.ProxyType === 'OnPremise';
    const authentication = config.Authentication ?? 'NoAuthentication';

    if (onPremise) {
      if (!this.connectivity) {
        return refuse(
          `Destination "${this.name}" is on premise, but no Connectivity service is bound.`,
          'Bind a "connectivity" service instance (plan lite) to the application.',
        );
      }
      if (config.CloudConnectorLocationId) {
        request.header(
          'SAP-Connectivity-SCC-Location_ID',
          config.CloudConnectorLocationId,
        );
      }
    }

    try {
      if (authentication === 'PrincipalPropagation') {
        if (!onPremise || !this.connectivity) {
          return refuse(
            `Destination "${this.name}": principal propagation works on premise only.`,
          );
        }
        if (!userJwt) {
          return refuse(
            `Destination "${this.name}" propagates the user, and this request carries no user token.`,
            'Log the MCP client on as a user (authorization code), not with client credentials.',
          );
        }
        const proxyToken = await jwtBearerToken(this.connectivity, userJwt);
        request.header('Proxy-Authorization', `Bearer ${proxyToken}`);
        return ok;
      }

      if (onPremise && this.connectivity) {
        const proxyToken = await clientCredentialsToken(this.connectivity);
        request.header('Proxy-Authorization', `Bearer ${proxyToken}`);
      }

      if (authentication === 'BasicAuthentication') {
        const basic = Buffer.from(
          `${config.User ?? ''}:${config.Password ?? ''}`,
        ).toString('base64');
        request.header('Authorization', `Basic ${basic}`);
        return ok;
      }

      if (authentication === 'NoAuthentication') return ok;

      const token = destination.authTokens[0];
      if (!token) {
        return refuse(
          `Destination "${this.name}": authentication "${authentication}" is not supported here.`,
          'Use BasicAuthentication, PrincipalPropagation or an OAuth2/SAML type.',
        );
      }
      if (token.error) {
        return refuse(
          `Destination "${this.name}": the Destination service could not issue a token (${token.error}).`,
        );
      }
      if (token.http_header) {
        request.header(token.http_header.key, token.http_header.value);
      } else {
        request.header('Authorization', `${token.type} ${token.value}`);
      }
      return ok;
    } catch (error) {
      return refuse(
        `Destination "${this.name}": a token could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  /**
   * A refused request drops what is held — the destination (its password may
   * have changed) and the proxy tokens — and buys one more attempt.
   */
  async rejected(_rejection: IAuthRejection): Promise<AuthOutcome> {
    this.destinations.forget(this.name);
    if (this.connectivity) forgetTokens(this.connectivity);
    if (this.retried) {
      return refuse(
        `Destination "${this.name}": the SAP system refused the credential.`,
        'Check the user and password (or the trust) of the destination.',
      );
    }
    this.retried = true;
    return ok;
  }
}
