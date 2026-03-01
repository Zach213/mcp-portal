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
