/**
 * server.js — Hosted MCP server for Portal
 *
 * Zero-config setup (like LiveKit docs MCP):
 *   Cursor:  { "portal": { "url": "https://mcp.makeportals.com/mcp" } }
 *   Claude:  claude mcp add --transport http portal https://mcp.makeportals.com/mcp
 *   Codex:   codex mcp add --url https://mcp.makeportals.com/mcp portal
 *
 * Auth is handled server-side via device authorization flow.
 * No Bearer token or local install required.
 *
 * Env:
 *   PORTAL_API_URL  — Portal API base (required)
 *   PORT            — HTTP port (default 3000)
 *   SESSION_TTL_MS  — Idle session TTL (default 30 min)
 */

const express = require('express');
const crypto = require('crypto');

const PORTAL_API = process.env.PORTAL_API_URL;
if (!PORTAL_API) {
  console.error('PORTAL_API_URL env var is required');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS, 10) || 30 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

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

// ── Session store ──

const sessions = new Map();

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      try { session.transport.close?.(); } catch {}
      sessions.delete(id);
    }
  }
}

setInterval(cleanupSessions, 60_000);

// ── API helpers ──

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

function authError() {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        code: 'not_authenticated',
        message: 'Not authenticated. Run the portal_login tool first — it opens a one-time browser link to sign in with Google.',
      }, null, 2),
    }],
    isError: true,
  };
}

// ── Device auth polling (server-side) ──

async function pollForApproval(deviceCode) {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${PORTAL_API}/v1/auth/device/token?device_code=${deviceCode}`);
      const data = await res.json();
      if (data.status === 'approved' && data.api_key) return data;
      if (data.status === 'expired') return { status: 'expired' };
    } catch {
      // Network error, retry
    }
  }
  return { status: 'timeout' };
}

// ── Tool registration ──

function registerTools(server, z, sessionState) {
  // getKey checks session state first, then Bearer header fallback
  const getKey = () => sessionState.apiKey || null;

  // ── Auth tools (always available) ──

  server.tool(
    'portal_login',
    [
      'Start Portal sign-in. Returns a verification_url.',
      'IMPORTANT: After receiving the URL, IMMEDIATELY open it in the user\'s browser using a shell command:',
      '  macOS: open "https://..."',
      '  Linux: xdg-open "https://..."',
      '  Windows: start "https://..."',
      'Then poll portal_login_check with the device_code every 5 seconds until approved.',
      'New users get 3 creation credits + 10 view credits on first sign-up.',
    ].join('\n'),
    {},
    async () => {
      if (getKey()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'already_authenticated',
              email: sessionState.email || 'unknown',
              message: 'Already signed in. Use portal_logout to sign out first.',
            }, null, 2),
          }],
        };
      }

      try {
        const res = await fetch(`${PORTAL_API}/v1/auth/device/code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const deviceData = await res.json();
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ code: 'device_code_failed', ...deviceData }, null, 2) }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'awaiting_approval',
              verification_url: deviceData.verification_url,
              user_code: deviceData.user_code,
              device_code: deviceData.device_code,
              message: 'Open the verification_url in your browser to sign in with Google. Then call portal_login_check with the device_code.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ code: 'connection_failed', message: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'portal_login_check',
    [
      'Poll for login approval after portal_login returned a device_code.',
      'Returns approved + API key once the user signs in, or pending/expired.',
      'Call this every few seconds until status is approved or expired.',
    ].join('\n'),
    { device_code: z.string().describe('The device_code from portal_login') },
    async ({ device_code }) => {
      if (getKey()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'already_authenticated',
              email: sessionState.email || 'unknown',
            }, null, 2),
          }],
        };
      }

      try {
        const res = await fetch(`${PORTAL_API}/v1/auth/device/token?device_code=${device_code}`);
        const data = await res.json();

        if (data.status === 'approved' && data.api_key) {
          sessionState.apiKey = data.api_key;
          sessionState.email = data.email;
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'authenticated',
                email: data.email,
                message: `Signed in as ${data.email}. Portal is ready.`,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: data.status || 'pending',
              message: data.status === 'expired'
                ? 'Authorization expired. Run portal_login again.'
                : 'Waiting for user to approve in browser. Call portal_login_check again in a few seconds.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ code: 'poll_failed', message: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'portal_logout',
    'Sign out of Portal for this session.',
    {},
    async () => {
      const had = !!sessionState.apiKey;
      sessionState.apiKey = null;
      sessionState.email = null;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: had,
            message: had ? 'Signed out.' : 'Not signed in.',
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'portal_status',
    [
      'Check Portal authentication status. CALL THIS FIRST before any other Portal tool.',
      '',
      'Portal creates interactive sandboxed browser sessions ("Portals") for any website.',
      'A Portal is a shareable link that opens a live, clickable browser session.',
      '',
      'After checking status:',
      '- If not authenticated: call portal_login, tell user to open the URL, then poll portal_login_check.',
      '- If authenticated: ask "What would you like to create a Portal for?"',
      '',
      'Two portal modes:',
      '  play — User explores freely. No script needed.',
      '  watch — Agent leads a guided demo following a script with scenes.',
      '',
      'User intent → which tools to use:',
      '  "Make a portal for [URL]" → validate_ptl + make_portal (mode: play). Costs 1 credit.',
      '  "Generate a demo for [URL]" → create_script → review draft → make_portal (mode: watch).',
      '  "Save my login for [site]" → save_login → user logs in via hosted browser → save_login_complete.',
      '  "Record a demo" → record_demo → user clicks in hosted browser → stop_recording.',
      '  "Store credentials" → create_credential.',
      '',
      'Three ways to generate a demo script:',
      '  1. Fast LLM (~12s): create_script with just a URL. Fetches page, LLM writes scenes. Best for public sites.',
      '  2. Headless exploration (~60-120s): create_script with saved_state_id. Browser navigates autonomously. Experimental.',
      '  3. Manual recording: record_demo → user clicks around in hosted browser → stop_recording compiles into scenes.',
      '',
      'All scripts return as drafts. Present scenes to user, ask if they want to edit.',
      'New users get 3 creation credits + 10 view credits on sign-up.',
    ].join('\n'),
    {},
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            authenticated: !!getKey(),
            email: sessionState.email || null,
            api_url: PORTAL_API,
          }, null, 2),
        }],
      };
    }
  );

  // ── Portal tools (require auth) ──

  server.tool(
    'normalize_ptl',
    'Normalize a .ptl Portal spec into canonical form.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/ptl/normalize', { ptl }, key);
    }
  );

  server.tool(
    'validate_ptl',
    'Validate a .ptl Portal spec without creating a portal.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/ptl/validate', { ptl }, key);
    }
  );

  server.tool(
    'make_portal',
    [
      'Create a Portal from a .ptl spec. Requires authentication — call portal_status first.',
      'Returns a shareable URL that opens a live, sandboxed browser session.',
      'Costs 1 creation credit. Session TTL is 10 minutes starting when the viewer opens the link.',
      '',
      'IMPORTANT BEHAVIOR:',
      '  - May return status "provisioning" if the VM pool is cold. This is NORMAL.',
      '  - If provisioning: poll get_portal every 15s for UP TO 5 MINUTES. Do NOT give up early.',
      '  - NEVER create a second portal if the first is still provisioning. That wastes credits.',
      '  - Give the user status updates while waiting: "Setting up your sandbox... (30s)", "Still spinning up... (60s)"',
      '  - If status is "ready", open the URL in the browser for the user.',
      '',
      'FOR WATCH MODE (agent-led demo with script):',
      '  Before calling make_portal, SHOW the user each scene in a readable format:',
      '    Scene 1: [name]',
      '      Narration: "[script text]"',
      '      Actions: click [selector], scroll down, etc.',
      '    Scene 2: ...',
      '  Ask: "Does this look good, or want to change anything?"',
      '  Only call make_portal AFTER the user approves the scenes.',
      '',
      'Schema quick reference:',
      '  entry.url: string (required)',
      '  experience.mode: "play" | "watch" (watch REQUIRES scenes + goal)',
      '  experience.agent.goal: string (REQUIRED for watch)',
      '  experience.agent.greeting: string',
      '  experience.agent.scenes: [{ script, actions: [{ action, selector?, text?, ms? }] }]',
      '  guardrails.allowed_urls: array of URL patterns',
      '  guardrails.disabled_elements: array of CSS selectors',
      '',
      '  Scene actions: click (needs selector), scroll_up, scroll_down, wait (optional ms), type (needs selector + text)',
    ].join('\n'),
    {
      ptl: z.object({}).passthrough(),
      idempotency_key: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ ptl, idempotency_key, dry_run }) => {
      const key = getKey();
      if (!key) return authError();
      const idem = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, idempotency_key: idem, dry_run }, key);
    }
  );

  server.tool(
    'get_portal',
    [
      'Poll portal provisioning status by ID.',
      '',
      'Statuses: "provisioning" (VM spinning up), "ready" (URL available), "failed" (error).',
      '',
      'IMPORTANT: Provisioning can take 30s-5min depending on pool warmth.',
      '  - Poll every 15 seconds. Keep polling for UP TO 5 MINUTES.',
      '  - Do NOT give up after a few attempts. Cold starts take time.',
      '  - Give the user friendly updates while waiting:',
      '    ~15s: "Setting up your sandboxed browser..."',
      '    ~45s: "Spinning up a fresh VM for you..."',
      '    ~90s: "Almost there — first portal of the day takes a bit longer..."',
      '    ~180s: "Still working on it — hang tight..."',
      '  - When status is "ready", the url field has the shareable link.',
      '  - Open the URL in the browser for the user automatically.',
    ].join('\n'),
    { portal_id: z.string() },
    async ({ portal_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', `/v1/portals/${encodeURIComponent(portal_id)}`, undefined, key);
    }
  );

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
    async ({ url, name }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/sessions/login', { url, name }, key);
    }
  );

  server.tool(
    'save_login_complete',
    'Save the login state after the user has logged in via the hosted UI.',
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/save`, {}, key);
    }
  );

  server.tool(
    'record_demo',
    [
      'Start a demo recording session — the user clicks around in a hosted browser while the system records.',
      'This is the most accurate way to generate a script because the user shows exactly what they want.',
      '',
      'Returns a hosted_url. Tell the user to open it, click through the demo they want, then tell you when done.',
      'After recording, call stop_recording with the session_id to compile into structured scenes.',
      'The compiled scenes can then be used in make_portal with mode "watch".',
      '',
      'Flow: record_demo → user opens hosted_url → clicks around → stop_recording → draft scenes',
    ].join('\n'),
    {
      url: z.string().describe('The URL to record a demo on'),
      saved_state_id: z.string().optional().describe('ID of a saved login to pre-authenticate'),
      name: z.string().optional().describe('Label for this recording'),
    },
    async ({ url, saved_state_id, name }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/sessions/record', { url, saved_state_id, name }, key);
    }
  );

  server.tool(
    'start_recording',
    'Begin the actual recording after user is ready at the hosted UI.',
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/start-recording`, {}, key);
    }
  );

  server.tool(
    'stop_recording',
    'Stop recording and compile the demo into a structured script.',
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/stop`, {}, key);
    }
  );

  server.tool(
    'get_session',
    'Poll the status of a login or recording session.',
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', `/v1/sessions/${encodeURIComponent(session_id)}`, undefined, key);
    }
  );

  server.tool(
    'create_script',
    [
      'Generate a demo script for a website.',
      '',
      'Two paths:',
      '  - Public URL (no saved_state_id): Fast (~12s). Fetches page content and generates scenes via LLM.',
      '  - With saved_state_id: Experimental (~60-120s). Opens headless browser with saved login, explores interactively.',
      '',
      'Returns script_id. Poll get_script until status is "draft".',
      'Draft scenes are for REVIEW — present them to the user and ask if they want to edit before creating a portal.',
      '',
      'After the user approves scenes, use them in make_portal with mode "watch".',
    ].join('\n'),
    {
      url: z.string().describe('URL to explore'),
      saved_state_id: z.string().optional().describe('Saved login for pre-authentication'),
      credential_id: z.string().optional().describe('Credential vault entry for auto-login'),
      goals: z.array(z.string()).optional().describe('Exploration goals'),
      max_pages: z.number().optional().describe('Max pages to visit (default 5)'),
    },
    async ({ url, saved_state_id, credential_id, goals, max_pages }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/scripts/generate', { url, saved_state_id, credential_id, goals, max_pages }, key);
    }
  );

  server.tool(
    'get_script',
    [
      'Poll script generation status. Returns status_message with progress updates.',
      '',
      'Statuses: "generating" (in progress), "draft" (ready for review), "failed" (error).',
      'When status is "draft", present the scenes to the user for review/editing.',
      'Show each scene: name, script (narration), and actions.',
      'Ask: "Want to edit any scenes before creating the portal?"',
    ].join('\n'),
    { script_id: z.string() },
    async ({ script_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', `/v1/scripts/${encodeURIComponent(script_id)}`, undefined, key);
    }
  );

  server.tool(
    'create_credential',
    [
      'Create a credential vault entry for automated login.',
      'Credentials are encrypted at rest and never returned via API.',
      'Use with save_login or create_script for pre-authenticated sessions.',
    ].join('\n'),
    {
      name: z.string().describe('Label for this credential'),
      domain: z.string().describe('Domain (e.g. "github.com")'),
      values: z.object({
        username: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional(),
      }).passthrough().describe('Login field values'),
      totp_secret: z.string().optional().describe('TOTP secret for 2FA'),
      sso_provider: z.string().optional().describe('SSO provider (google, github, microsoft)'),
    },
    async ({ name, domain, values, totp_secret, sso_provider }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/credentials', { name, domain, values, totp_secret, sso_provider }, key);
    }
  );

  server.tool(
    'list_credentials',
    'List all credential vault entries (metadata only, no secrets).',
    {},
    async () => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', '/v1/credentials', undefined, key);
    }
  );

  server.tool(
    'delete_credential',
    'Delete a credential vault entry.',
    { credential_id: z.string() },
    async ({ credential_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('DELETE', `/v1/credentials/${encodeURIComponent(credential_id)}`, undefined, key);
    }
  );
}

// ── Express app with session-aware MCP ──

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-portal', sessions: sessions.size });
});

app.post('/mcp', async (req, res) => {
  try {
    const { McpServer, StreamableHTTPServerTransport, z } = await getMcpModules();
    const existingSessionId = req.headers['mcp-session-id'];

    if (existingSessionId && sessions.has(existingSessionId)) {
      const session = sessions.get(existingSessionId);
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — check for optional Bearer token (advanced users)
    const auth = req.headers.authorization;
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    const sessionState = { apiKey: bearerToken, email: null };
    const server = new McpServer({ name: 'portal-mcp', version: '1.0.0' });
    registerTools(server, z, sessionState);

    let capturedSessionId;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        capturedSessionId = crypto.randomUUID();
        return capturedSessionId;
      },
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (capturedSessionId) {
      sessions.set(capturedSessionId, {
        server,
        transport,
        state: sessionState,
        lastActivity: Date.now(),
      });
    }
  } catch (err) {
    console.error('[MCP] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP transport error' });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({
      error: 'Missing or invalid session. Send a POST first to initialize.',
    });
    return;
  }
  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    try { await session.transport.close?.(); } catch {}
    sessions.delete(sessionId);
  }
  res.status(200).json({ terminated: true });
});

app.listen(PORT, () => {
  console.log(`MCP Portal server running on port ${PORT}`);
  console.log(`Portal API: ${PORTAL_API}`);
  console.log(`MCP endpoint: POST /mcp`);
  console.log(`Session TTL: ${SESSION_TTL_MS / 60000} min`);
});
