/**
 * What Cloud Foundry hands the application: its bound service instances
 * (`VCAP_SERVICES`) and its own routes (`VCAP_APPLICATION`).
 *
 * A binding is found by its service label, not by its instance name, so the
 * MTA can call the instances whatever it likes.
 */

export interface OAuthClientCredentials {
  clientid: string;
  clientsecret: string;
  /** The UAA of the subaccount. */
  url: string;
  /** Where tokens are fetched, when it differs from `url`. */
  token_service_url?: string;
}

export interface XsuaaCredentials extends OAuthClientCredentials {
  xsappname: string;
  uaadomain?: string;
  identityzone?: string;
}

export interface DestinationCredentials extends OAuthClientCredentials {
  /** The Destination service's REST API. */
  uri: string;
}

export interface ConnectivityCredentials extends OAuthClientCredentials {
  onpremise_proxy_host: string;
  onpremise_proxy_http_port?: string;
  onpremise_proxy_port?: string;
}

type Binding = { label?: string; credentials?: unknown };

function services(env: NodeJS.ProcessEnv): Record<string, Binding[]> {
  const raw = env.VCAP_SERVICES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Binding[]>;
  } catch {
    throw new Error('VCAP_SERVICES is not valid JSON');
  }
}

/** The credentials of the first binding with this label, if any. */
export function credentialsOf<T>(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): T | undefined {
  const bindings = services(env)[label];
  return bindings?.[0]?.credentials as T | undefined;
}

/** The application's public base URL (`https://<first route>`), if CF states one. */
export function applicationBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.VCAP_APPLICATION;
  if (!raw) return undefined;
  try {
    const app = JSON.parse(raw) as { application_uris?: string[] };
    const uri = app.application_uris?.[0];
    return uri ? `https://${uri}` : undefined;
  } catch {
    return undefined;
  }
}
