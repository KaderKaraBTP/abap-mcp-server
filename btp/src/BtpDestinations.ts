/**
 * The server's destinations, served from the SAP BTP Destination service.
 *
 * This is the seam the server already has (`IDestinations`): the settings of a
 * destination and its credential. The settings come from the BTP destination
 * (`URL`, `sap-client`); the credential is a `BtpDestinationAuthProvider`.
 * An on-premise destination's URL is registered so its connections are sent
 * through the connectivity proxy (`proxyFor`).
 *
 * `MCP_ALLOWED_DESTINATIONS` (comma-separated), when set, is the list of
 * destination names a request may use; any other is refused before the
 * Destination service is asked.
 */

import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type {
  DestinationSystemContext,
  IDestinations,
} from '@mcp-abap-adt/lib/auth';
import type { HttpProxy } from '@mcp-abap-adt/lib/utils';
import { BtpDestinationAuthProvider } from './BtpDestinationAuthProvider';
import type { DestinationService } from './destinationService';
import { currentUser } from './requestUser';
import type { ConnectivityCredentials } from './vcap';

export class BtpDestinations implements IDestinations {
  private readonly onPremiseUrls = new Set<string>();
  private readonly proxy?: HttpProxy;

  constructor(
    private readonly service: DestinationService,
    private readonly connectivity: ConnectivityCredentials | undefined,
    private readonly allowed: ReadonlySet<string> | undefined,
  ) {
    if (connectivity) {
      this.proxy = {
        protocol: 'http',
        host: connectivity.onpremise_proxy_host,
        port: Number(
          connectivity.onpremise_proxy_http_port ??
            connectivity.onpremise_proxy_port ??
            20003,
        ),
      };
    }
  }

  async settingsFor(destination: string): Promise<SapConfig> {
    this.assertAllowed(destination);
    // The server answers a failed destination with its error class only;
    // these messages are ours and carry no secret, so the reason is logged.
    const { configuration } = await this.service
      .find(destination, currentUser().userJwt)
      .catch((error: unknown) => {
        console.error(
          `[BTP] ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
    const url = configuration.URL.replace(/\/+$/, '');
    if (configuration.ProxyType === 'OnPremise') this.onPremiseUrls.add(url);
    const systemType = (
      configuration['mcp-system-type'] ??
      process.env.SAP_SYSTEM_TYPE ??
      'onprem'
    ).toLowerCase();
    return {
      url,
      client: configuration['sap-client'] ?? configuration.sapclient,
      // Read by the connector only to tell a cloud system from an on-premise
      // one; the credential is the provider's whatever this says.
      authType: systemType === 'cloud' ? 'jwt' : 'basic',
      connectionType: 'http',
    };
  }

  async getProvider(destination: string): Promise<IAuthProvider> {
    this.assertAllowed(destination);
    return new BtpDestinationAuthProvider(
      destination,
      this.service,
      this.connectivity,
    );
  }

  /**
   * What the destination states about who answers for a change: the
   * additional properties `SAP_RESPONSIBLE` and `SAP_MASTER_SYSTEM`, and the
   * logon user of a `BasicAuthentication` destination. The server takes the
   * login as the responsible only when no responsible is stated anywhere
   * (tool argument, `x-sap-responsible`, this property, the process).
   * SAP user names are upper case, so these are too.
   */
  async systemContextFor(
    destination: string,
  ): Promise<DestinationSystemContext> {
    this.assertAllowed(destination);
    const { configuration } = await this.service.find(
      destination,
      currentUser().userJwt,
    );
    const upper = (value: string | undefined) =>
      value?.trim() ? value.trim().toUpperCase() : undefined;
    const context: DestinationSystemContext = {};
    const responsible = upper(configuration.SAP_RESPONSIBLE);
    const masterSystem = upper(configuration.SAP_MASTER_SYSTEM);
    const login =
      configuration.Authentication === 'BasicAuthentication'
        ? upper(configuration.User)
        : undefined;
    if (responsible) context.responsible = responsible;
    if (masterSystem) context.masterSystem = masterSystem;
    if (login) context.login = login;
    return context;
  }

  /** The connectivity proxy for an on-premise destination's URL; none otherwise. */
  proxyFor(settings: SapConfig): HttpProxy | undefined {
    const url = settings.url?.replace(/\/+$/, '');
    return url && this.onPremiseUrls.has(url) ? this.proxy : undefined;
  }

  private assertAllowed(destination: string): void {
    if (this.allowed && !this.allowed.has(destination)) {
      throw new Error(
        `Destination "${destination}" is not in MCP_ALLOWED_DESTINATIONS.`,
      );
    }
  }
}
