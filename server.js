/**
 * server.js — Hosted MCP server for Portal
 *
 * Exposes Portal MCP tools over Streamable HTTP transport.
 * Clients connect with:
 *   { "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer ptl_xxx" } }
 *
 * The bearer token is forwarded to the Portal API so auth + rate limits
 * apply identically to the local stdio MCP server.
 *
 * Env:
 *   PORTAL_API_URL  — Portal API base URL (required)
 *   PORT            — HTTP port (default 3000)
 */

const express = require('express');
const crypto = require('crypto');

const PORTAL_API = process.env.PORTAL_API_URL;
if (!PORTAL_API) {
  console.error('PORTAL_API_URL env var is required');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

let _mcpModules = null;

async function getMcpModules() {
  if (_mcpModules) return _mcpModules;
  const [serverMod, transportMod, zodMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('zod'),
  ]);
  _mcpModules = {
    McpServer: serverMod.McpServer,
    StreamableHTTPServerTransport: transportMod.StreamableHTTPServerTransport,
    z: zodMod.z,
  };
  return _mcpModules;
}

async function apiCall(method, path, body, bearerToken) {
  const url = `${PORTAL_API}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ code: 'connection_failed', message: err.message }, null, 2) }],
      isError: true,
    };
  }

  const data = await res.json();
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: !res.ok,
  };
}

function registerTools(server, z, bearerToken) {
  server.tool(
    'normalize_ptl',
    'Normalize a .ptl Portal spec into canonical form.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => apiCall('POST', '/v1/ptl/normalize', { ptl }, bearerToken)
  );

  server.tool(
    'validate_ptl',
    'Validate a .ptl Portal spec without creating a portal.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => apiCall('POST', '/v1/ptl/validate', { ptl }, bearerToken)
  );

  server.tool(
    'make_portal',
    [
      'Create a Portal from a .ptl spec.',
      'Returns a shareable URL that opens a live, sandboxed browser session.',
      'Session TTL is 10 minutes starting when the viewer opens the link.',
      '',
      'Schema quick reference:',
      '  entry.url: string (required)',
      '  experience.mode: "play" (user explores) | "watch" (agent-led demo, REQUIRES scenes + goal)',
      '  experience.agent.goal: string (REQUIRED for watch mode)',
      '  experience.agent.greeting: string',
      '  experience.agent.scenes: [{ script, actions: [{ action, selector?, text?, ms? }] }] (REQUIRED for watch mode)',
      '  guardrails.allowed_urls: array of URL patterns',
      '  guardrails.disabled_elements: array of CSS selectors',
      '',
      '  Scene actions: click (needs selector), scroll_up, scroll_down, wait (optional ms), type (needs selector + text)',
      '  Default mode is "play".',
    ].join('\n'),
    {
      ptl: z.object({}).passthrough(),
      idempotency_key: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ ptl, idempotency_key, dry_run }) => {
      const key = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, idempotency_key: key, dry_run }, bearerToken);
    }
  );

  server.tool(
    'get_portal',
    'Get the current status of a portal by ID.',
    { portal_id: z.string() },
    async ({ portal_id }) => apiCall('GET', `/v1/portals/${encodeURIComponent(portal_id)}`, undefined, bearerToken)
  );

  // ── MCP v1 Primitives: saveLogin, recordDemo, createScript ──

  server.tool(
    'save_login',
    [
      'Start a login capture session. Opens a sandboxed browser at the given URL.',
      'Returns a hosted_url that the user opens in their browser to log in.',
      'After login, call save_login_complete with the session_id to save the state.',
      '',
      'Flow: save_login → user opens hosted_url → logs in → save_login_complete',
    ].join('\n'),
    {
      url: z.string().describe('The URL to navigate to for login'),
      name: z.string().optional().describe('Label for this saved login'),
    },
    async ({ url, name }) => apiCall('POST', '/v1/sessions/login', { url, name }, bearerToken)
  );

  server.tool(
    'save_login_complete',
    'Save the login state after the user has logged in via the hosted UI. Call after user finishes at the hosted_url.',
    { session_id: z.string() },
    async ({ session_id }) => apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/save`, {}, bearerToken)
  );

  server.tool(
    'record_demo',
    [
      'Start a demo recording session. Opens a sandboxed browser at the given URL.',
      'Returns a hosted_url where the user clicks around and talks to record a demo.',
      'After recording, call stop_recording with the session_id to compile.',
      '',
      'Flow: record_demo → user opens hosted_url → records → stop_recording',
    ].join('\n'),
    {
      url: z.string().describe('The URL to record a demo on'),
      saved_state_id: z.string().optional().describe('ID of a saved login to pre-authenticate'),
      name: z.string().optional().describe('Label for this recording'),
    },
    async ({ url, saved_state_id, name }) => apiCall('POST', '/v1/sessions/record', { url, saved_state_id, name }, bearerToken)
  );

  server.tool(
    'start_recording',
    'Begin the actual recording after user is ready at the hosted UI.',
    { session_id: z.string() },
    async ({ session_id }) => apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/start-recording`, {}, bearerToken)
  );

  server.tool(
    'stop_recording',
    'Stop recording and compile the demo into a structured script.',
    { session_id: z.string() },
    async ({ session_id }) => apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/stop`, {}, bearerToken)
  );

  server.tool(
    'get_session',
    'Poll the status of a login or recording session.',
    { session_id: z.string() },
    async ({ session_id }) => apiCall('GET', `/v1/sessions/${encodeURIComponent(session_id)}`, undefined, bearerToken)
  );

  server.tool(
    'create_script',
    [
      'Generate a demo script by headless exploration (experimental).',
      'Navigates the site autonomously using an LLM agent, captures selectors and page structure,',
      'then compiles into a reusable script with scenes, pages, and tools.',
      '',
      'Returns immediately with script_id. Poll get_script for results.',
    ].join('\n'),
    {
      url: z.string().describe('URL to explore'),
      saved_state_id: z.string().optional().describe('Saved login for pre-authentication'),
      credential_id: z.string().optional().describe('Credential vault entry for auto-login'),
      goals: z.array(z.string()).optional().describe('Exploration goals (e.g. "find the analytics dashboard")'),
      max_pages: z.number().optional().describe('Max pages to visit (default 5)'),
    },
    async ({ url, saved_state_id, credential_id, goals, max_pages }) =>
      apiCall('POST', '/v1/scripts/generate', { url, saved_state_id, credential_id, goals, max_pages }, bearerToken)
  );

  server.tool(
    'get_script',
    'Poll the status of a headless script generation.',
    { script_id: z.string() },
    async ({ script_id }) => apiCall('GET', `/v1/scripts/${encodeURIComponent(script_id)}`, undefined, bearerToken)
  );

  // ── Credential Vault ──

  server.tool(
    'create_credential',
    [
      'Create a credential vault entry for automated login.',
      'Credentials are encrypted at rest and never returned via API.',
      'Use with save_login or create_script for pre-authenticated sessions.',
    ].join('\n'),
    {
      name: z.string().describe('Label for this credential'),
      domain: z.string().describe('Domain this credential is for (e.g. "github.com")'),
      values: z.object({
        username: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional(),
      }).passthrough().describe('Login field values'),
      totp_secret: z.string().optional().describe('TOTP authenticator secret for 2FA'),
      sso_provider: z.string().optional().describe('SSO provider (google, github, microsoft)'),
    },
    async ({ name, domain, values, totp_secret, sso_provider }) =>
      apiCall('POST', '/v1/credentials', { name, domain, values, totp_secret, sso_provider }, bearerToken)
  );

  server.tool(
    'list_credentials',
    'List all credential vault entries (metadata only, no secrets).',
    {},
    async () => apiCall('GET', '/v1/credentials', undefined, bearerToken)
  );

  server.tool(
    'delete_credential',
    'Delete a credential vault entry.',
    { credential_id: z.string() },
    async ({ credential_id }) => apiCall('DELETE', `/v1/credentials/${encodeURIComponent(credential_id)}`, undefined, bearerToken)
  );
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-portal' });
});

app.post('/mcp', async (req, res) => {
  try {
    const { McpServer, StreamableHTTPServerTransport, z } = await getMcpModules();

    const auth = req.headers.authorization;
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    const server = new McpServer({ name: 'portal-mcp', version: '1.0.0' });
    registerTools(server, z, bearerToken);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP transport error' });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed. Use POST.' });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed. Use POST.' });
});

app.listen(PORT, () => {
  console.log(`MCP Portal server running on port ${PORT}`);
  console.log(`Portal API: ${PORTAL_API}`);
  console.log(`MCP endpoint: POST /mcp`);
});
