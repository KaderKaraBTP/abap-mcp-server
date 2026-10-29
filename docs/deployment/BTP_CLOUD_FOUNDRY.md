# SAP BTP Cloud Foundry: a remote MCP server for on-premise ABAP

The server runs as a Cloud Foundry application and serves MCP over streamable
HTTP. The SAP systems it reaches are **BTP destinations**. An on-premise
system is reached through the **Connectivity service and the Cloud
Connector**, so nothing in the corporate network is opened to the internet.

```
MCP client ──HTTPS + XSUAA bearer──▶ CF app (btp/)  ──▶ Destination service (URL, credentials)
                                        │
                                        └─▶ connectivity proxy ──▶ Cloud Connector ──▶ S/4HANA (ADT, /sap/bc/adt)
```

| Piece | Where |
|---|---|
| CF entry point, BTP destinations, XSUAA guard | `btp/src/` |
| MTA development descriptor | `mta.yaml` |
| XSUAA scopes, roles, redirect URIs | `xs-security.json` |
| Proxy hook used by the connector | `setHttpProxyResolver` in `src/lib/connectionFactory.ts` |

`btp/scripts/build.mjs` compiles the lib and the core server **from this
checkout**, packs them into `btp/vendor/`, and compiles `btp/src`. Cloud
Foundry then installs exactly that code. It does not install what is
published on npm.

## 1. Cloud Connector (once per backend)

In the Cloud Connector connected to your subaccount:

1. **Cloud To On-Premise → Access Control → Add**: back-end type *ABAP
   System*, protocol *HTTPS* (or HTTP), internal host and port of the ICM.
   Choose a **virtual host and port**, for example `s4h-adt:44300`.
2. Principal type: *None* for basic authentication, or *X.509 Certificate*
   for principal propagation.
3. Resources on that mapping, each with *Path and all sub-paths*:
   - `/sap/bc/adt/`
   - `/sap/public/bc/icf/logoff`
4. Check that the subaccount shows the connector as **Connected**: in the
   cockpit, *Connectivity → Cloud Connectors*. If you use a Location ID,
   note it.

## 2. Destination (in the subaccount, or in the space)

*Connectivity → Destinations → New Destination*:

| Field | Value |
|---|---|
| Name | `S4H_ADT` (or anything; set `SAP_DESTINATION` in `mta.yaml` to the same name) |
| Type | HTTP |
| URL | `http://s4h-adt:44300` (the **virtual** host, always `http://`; the Cloud Connector speaks HTTPS to the backend) |
| Proxy Type | OnPremise |
| Authentication | `BasicAuthentication` (technical or developer user), or `PrincipalPropagation` |
| Location ID | only if your Cloud Connector uses one |
| Additional property `sap-client` | e.g. `100` |
| Additional property `mcp-system-type` | optional: `onprem` (default) or `cloud` |

You can define more destinations, one per system or client. A request picks
one with the `x-mcp-destination` header (`MCP_ALLOW_DESTINATION_HEADER`), and
`MCP_ALLOWED_DESTINATIONS` restricts which names are accepted.

**Supported authentication types:**
- `BasicAuthentication`: every call runs as that SAP user.
- `PrincipalPropagation`: each MCP user is logged on as themselves. The user's
  XSUAA token is exchanged at the Connectivity service. This needs trust
  between the Cloud Connector and the backend (system certificate, `CERTRULE`).
  The MCP client must log on as a **user** (authorization code), not with
  client credentials.
- `NoAuthentication`.
- Any OAuth2/SAML type for which the Destination service issues `authTokens`.

## 3. Build and deploy

Prerequisites: Node 22 or later, `mbt` (`npm i -g mbt`), the `cf` CLI with the
`multiapps` plugin, and a logged-in target:

```bash
cf login -a https://api.cf.ca10.hana.ondemand.com   # org olymel-devops, space MCP
cf target

npm ci                 # once, at the repo root
npm run btp:mtar       # → mta_archives/abap-mcp-server.mtar (no GNU make needed)
npm run btp:deploy     # cf deploy mta_archives/abap-mcp-server.mtar
```

(`mbt build` works too if GNU make is installed.)

The deployment creates:

| Name | What |
|---|---|
| `abap-mcp-server` | the app |
| `abap-mcp-xsuaa` | XSUAA, plan `application`, with `xsappname` `abap-mcp-server-<space>` |
| `abap-mcp-destination` | Destination service, plan `lite` |
| `abap-mcp-connectivity` | Connectivity service, plan `lite` |

The route is printed at the end of `cf deploy`, or shown by `cf app
abap-mcp-server`. Typically it is
`https://<org>-<space>-abap-mcp-server.cfapps.ca10.hana.ondemand.com`.

Check that it is running: `curl https://<route>/mcp/health` (open, no token).

## 4. Who may call it

The MCP endpoint is `https://<route>/mcp`. It needs a bearer token of
`abap-mcp-xsuaa` that carries the `MCPUser` scope.

**Users.** Assign the role collection **`ABAP_MCP_User`** in the cockpit
(*Security → Users*, or through an IdP group).

**Technical clients** use client credentials. The token carries `MCPUser`
through `authorities`.

```bash
cf create-service-key abap-mcp-xsuaa mcp-client
cf service-key abap-mcp-xsuaa mcp-client    # clientid, clientsecret, url

curl -s -u "<clientid>:<clientsecret>" \
  "<url>/oauth/token" -d grant_type=client_credentials | jq -r .access_token
```

A client-credentials token has no user, so it cannot be used with
principal-propagation destinations.

**OAuth discovery.** An unauthenticated call answers `401` with
`WWW-Authenticate: Bearer resource_metadata=…`. The metadata is served at
`/.well-known/oauth-protected-resource/mcp` and names XSUAA as the
authorization server. XSUAA has no dynamic client registration, so give the
MCP client the `clientid`/`clientsecret` of a service key. The redirect URIs
the client may use are listed in `xs-security.json` (`oauth2-configuration`).

## 5. Client configuration

Claude Code:

```bash
claude mcp add --transport http abap https://<route>/mcp \
  --header "Authorization: Bearer <token>" \
  --header "x-mcp-destination: S4H_ADT"
```

Claude Desktop (`claude_desktop_config.json`) starts only local servers, so it
reaches the route through `mcp-remote`. XSUAA has no dynamic client
registration: give it the `clientid`/`clientsecret` of a service key in a file,
and it runs the authorization code flow in the browser and refreshes the token.
Its callback, `http://localhost:3334/oauth/callback`, is covered by the
`http://localhost:*/**` redirect URI.

```powershell
cf create-service-key abap-mcp-xsuaa claude-desktop
$guid = (cf service-key abap-mcp-xsuaa claude-desktop --guid).Trim()
$k = (cf curl "/v3/service_credential_bindings/$guid/details" | Out-String | ConvertFrom-Json).credentials
New-Item -ItemType Directory -Force "$HOME\.mcp-auth" | Out-Null
[IO.File]::WriteAllText("$HOME\.mcp-authbap-client.json",
  (@{ client_id = $k.clientid; client_secret = $k.clientsecret } | ConvertTo-Json -Compress))
```

```json
{
  "mcpServers": {
    "abap": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.15.2", "https://<route>/mcp", "3334",
        "--header", "x-mcp-destination:<destination>",
        "--static-oauth-client-info", "@C:\Users\<you>\.mcp-auth\abap-client.json"
      ]
    }
  }
}
```

Write the header without a space after the colon: on Windows `npx` splits an
argument at a space. The user who logs on needs the `ABAP_MCP_User` role
collection.

Generic `mcp.json` (Cline, Cursor, VS Code):

```json
{
  "mcpServers": {
    "abap": {
      "type": "streamableHttp",
      "url": "https://<route>/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "x-mcp-destination": "S4H_ADT"
      }
    }
  }
}
```

`x-mcp-destination` is optional when `SAP_DESTINATION` is set. A
client-credentials token expires after `token-validity` (1 h). Refresh it, or
use a client that runs the OAuth flow.

## 6. Settings (`mta.yaml` → `properties`)

| Variable | Default | Meaning |
|---|---|---|
| `SAP_DESTINATION` | — | Destination used when a request names none |
| `MCP_ALLOW_DESTINATION_HEADER` | `true` | Whether `x-mcp-destination` may choose another destination |
| `MCP_ALLOWED_DESTINATIONS` | (any) | Comma-separated allowlist of destination names |
| `MCP_EXPOSITION` | `readonly,high` | Tool groups: `readonly`, `high`, `low`, `debug` |
| `SAP_SYSTEM_TYPE` | `onprem` | Default system kind. A destination's `mcp-system-type` overrides it |
| `MCP_PATH` | `/mcp` | MCP endpoint path |
| `MCP_SCOPE` | `MCPUser` | Local scope a caller needs |
| `MCP_AUTH` | `xsuaa` | `none` turns the guard off, for local testing only. Never use it on a route |
| `DESTINATION_CACHE_SECONDS` | `300` | How long a destination lookup is kept |
| `DEBUG_HTTP_WIRE` | — | `true`: log every ADT exchange on stderr. Credential headers are redacted |

After changing a property, redeploy, or run `cf set-env abap-mcp-server
<VAR> <value>` and then `cf restage abap-mcp-server`.

## 7. Security notes

- Only destinations are used. The direct-connection headers `x-sap-url`,
  `x-sap-login`, `x-sap-password` and `x-sap-jwt-token` are removed from
  every request, so a caller cannot point the server at another host.
- With `BasicAuthentication`, every MCP user acts as the destination's SAP
  user. Give that user only the authorizations the exposed tools need, or use
  principal propagation. Expose `low`/`debug` only deliberately.
- The `state_handle` of a stateful session (debugger and similar) is a bearer
  secret. See `SECURITY.md`.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `cf logs abap-mcp-server --recent` shows `No Destination service is bound` | Resource not created. Check `cf services` |
| `BTP destination "…" was not found` | Name mismatch, or the destination is in another subaccount |
| `503`/`502` from the proxy, or `Connection refused` | Cloud Connector not connected, wrong virtual host or port, Location ID mismatch, or the resource path is not exposed |
| `503` *There is no SAP Cloud Connector (SCC) connected to your subaccount matching the requested tunnel … and SCC location ID "…"* | The destination's Location ID differs from the connector's. The connector's tunnel id ends in its location (`account:///<subaccount>/<location>` in `ljs_trace.log`); copy it exactly, or leave both empty |
| `initialize … FAILED: AxiosError` in the app log, nothing else | The ADT request failed below the connector's logging. Repeat it from the container (`cf enable-ssh`, restart, `cf ssh`) with the destination's URL, the Connectivity token as `Proxy-Authorization` and the proxy from `VCAP_SERVICES`; the proxy's body names the cause |
| Client: `IssuerMismatchError … expected "https://<subdomain>.authentication…", received "…/oauth/token"` | The protected resource metadata named XSUAA's bare URL. It names `<url>/oauth/token`, the issuer XSUAA states; redeploy a build that has it |
| `organization's memory limit exceeded: staging requires …` on restage | Staging needs the app's memory a second time. Lower `memory`, or apply an env change with `cf restart` (no staging) |
| `403` from SAP on `/sap/bc/adt/...` | The SAP user lacks ADT authorization (`S_ADT_RES`, `S_DEVELOP`) |
| `401` from the app | The token is missing or expired, or has no `MCPUser` scope. Assign `ABAP_MCP_User`, or check the service key's client |
