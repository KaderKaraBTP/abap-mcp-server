/**
 * The MCP ABAP ADT server as a SAP BTP Cloud Foundry application.
 *
 * - MCP over streamable HTTP at `MCP_PATH` (default `/mcp`), behind XSUAA;
 * - SAP systems are BTP destinations: the default one (`SAP_DESTINATION`),
 *   or the one a request names in `x-mcp-destination`
 *   (`MCP_ALLOW_DESTINATION_HEADER=true`);
 * - on-premise destinations go through the Connectivity service and the
 *   Cloud Connector;
 * - `/mcp/health` is open, for the platform's health check.
 *
 * Environment (set in mta.yaml):
 *   SAP_DESTINATION               default destination name
 *   MCP_ALLOW_DESTINATION_HEADER  true: x-mcp-destination picks another one
 *   MCP_ALLOWED_DESTINATIONS      comma-separated allowlist (optional)
 *   MCP_EXPOSITION                tool groups: readonly,high[,low][,debug]
 *   MCP_SCOPE                     local scope a caller needs (default MCPUser)
 *   MCP_AUTH                      xsuaa (default) | none (local testing only)
 */

import type { HandlerContext, IHandlerGroup } from '@mcp-abap-adt/lib/handlers';
import {
  CompositeHandlersRegistry,
  DebugHandlersGroup,
  HighLevelHandlersGroup,
  LowLevelHandlersGroup,
  ReadOnlyHandlersGroup,
  ReadVsGetDedupStrategy,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/lib/handlers';
import { setHttpProxyResolver } from '@mcp-abap-adt/lib/utils';
import { StreamableHttpServer } from '@mcp-abap-adt/core';
import express, { type Request, type Response } from 'express';
import { BtpDestinations } from './BtpDestinations';
import { DestinationService } from './destinationService';
import { runAsUser } from './requestUser';
import {
  applicationBaseUrl,
  type ConnectivityCredentials,
  credentialsOf,
  type DestinationCredentials,
  type XsuaaCredentials,
} from './vcap';
import { protectedResourceMetadata, xsuaaGuard } from './xsuaaGuard';

type Exposition = 'readonly' | 'high' | 'low' | 'debug';

function expositionFrom(raw: string | undefined): Exposition[] {
  const words = (raw ?? 'readonly,high')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  for (const word of words) {
    if (!['readonly', 'high', 'low', 'debug'].includes(word)) {
      throw new Error(`MCP_EXPOSITION: unknown group "${word}"`);
    }
  }
  return words as Exposition[];
}

/** The tool list, built as the standalone launcher builds it. */
function handlersFor(exposition: Exposition[]): CompositeHandlersRegistry {
  const baseContext = {
    connection: undefined as any,
    logger: undefined,
  } satisfies HandlerContext;

  const overriding: IHandlerGroup[] = [];
  if (exposition.includes('high'))
    overriding.push(new HighLevelHandlersGroup(baseContext));
  if (exposition.includes('low'))
    overriding.push(new LowLevelHandlersGroup(baseContext));
  if (exposition.includes('debug'))
    overriding.push(new DebugHandlersGroup(baseContext));

  const overridingNames = new Set<string>();
  for (const group of overriding) {
    for (const entry of group.getHandlers()) {
      overridingNames.add(entry.toolDefinition.name);
    }
  }

  const groups: IHandlerGroup[] = [];
  if (exposition.includes('readonly')) {
    groups.push(
      new ReadOnlyHandlersGroup(
        baseContext,
        overridingNames,
        new ReadVsGetDedupStrategy(),
      ),
    );
    groups.push(new SystemHandlersGroup(baseContext));
  }
  groups.push(...overriding);
  groups.push(new SearchHandlersGroup(baseContext));
  return new CompositeHandlersRegistry(groups);
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(env.PORT ?? 8080);
  const path = env.MCP_PATH ?? '/mcp';
  const scope = env.MCP_SCOPE ?? 'MCPUser';
  const authMode = (env.MCP_AUTH ?? 'xsuaa').toLowerCase();

  const destinationCredentials =
    credentialsOf<DestinationCredentials>('destination');
  if (!destinationCredentials) {
    throw new Error('No Destination service is bound (label "destination").');
  }
  const connectivity = credentialsOf<ConnectivityCredentials>('connectivity');
  if (!connectivity) {
    console.error(
      '[BTP] No Connectivity service bound: on-premise destinations will be refused.',
    );
  }
  const allowed = env.MCP_ALLOWED_DESTINATIONS
    ? new Set(
        env.MCP_ALLOWED_DESTINATIONS.split(',')
          .map((d) => d.trim())
          .filter(Boolean),
      )
    : undefined;

  const destinations = new BtpDestinations(
    new DestinationService(destinationCredentials),
    connectivity,
    allowed,
  );
  setHttpProxyResolver((settings) => destinations.proxyFor(settings));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const baseUrl = applicationBaseUrl() ?? `http://localhost:${port}`;
  const metadataPath = `/.well-known/oauth-protected-resource${path}`;

  if (authMode === 'xsuaa') {
    const xsuaa = credentialsOf<XsuaaCredentials>('xsuaa');
    if (!xsuaa) {
      throw new Error(
        'No XSUAA service is bound (label "xsuaa"). Bind one, or set MCP_AUTH=none for local testing only.',
      );
    }
    const metadata = protectedResourceMetadata(
      `${baseUrl}${path}`,
      xsuaa,
      scope,
    );
    const serveMetadata = (_req: Request, res: Response) => {
      res.json(metadata);
    };
    app.get(metadataPath, serveMetadata);
    app.get('/.well-known/oauth-protected-resource', serveMetadata);
    // app.all, not app.use: a prefix match would also guard /mcp/health.
    app.all(
      path,
      xsuaaGuard({
        credentials: xsuaa,
        scope,
        resourceMetadataUrl: `${baseUrl}${metadataPath}`,
      }),
    );
  } else if (authMode === 'none') {
    console.error(
      '[BTP] MCP_AUTH=none: the MCP endpoint is NOT protected. Never use this on a public route.',
    );
    app.all(path, (_req, _res, next) => runAsUser({}, next));
  } else {
    throw new Error(`MCP_AUTH must be xsuaa or none, not "${authMode}"`);
  }

  app.use(express.json({ limit: env.MCP_BODY_LIMIT ?? '10mb' }));

  const server = new StreamableHttpServer(
    handlersFor(expositionFrom(env.MCP_EXPOSITION)),
    destinations,
    {
      app: app as any,
      path,
      defaultDestination: env.SAP_DESTINATION || undefined,
      allowDestinationHeader: env.MCP_ALLOW_DESTINATION_HEADER === 'true',
      enableJsonResponse: env.MCP_JSON_RESPONSE !== 'false',
    },
  );
  await server.start();

  const listener = app.listen(port, '0.0.0.0', () => {
    console.error(`[BTP] MCP endpoint: ${baseUrl}${path}`);
    console.error(
      `[BTP] Default destination: ${env.SAP_DESTINATION || '(none: x-mcp-destination required)'}`,
    );
  });

  const shutdown = (signal: string) => {
    console.error(`[BTP] ${signal}: shutting down`);
    listener.close();
    server
      .stop()
      .catch((error) => console.error('[BTP] state cleanup failed:', error))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(
    '[BTP] start failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
