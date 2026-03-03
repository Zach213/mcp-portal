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
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

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

// ── Session persistence (survives server restarts) ──

async function persistSession(sessionId, apiKey, email) {
  if (!INTERNAL_SECRET) return;
  try {
    await fetch(`${PORTAL_API}/v1/auth/mcp-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ session_id: sessionId, api_key: apiKey, email }),
    });
  } catch (err) {
    console.warn('[Session] Persist failed (non-critical):', err.message);
  }
}

async function restoreSession(sessionId) {
  if (!INTERNAL_SECRET) return null;
  try {
    const res = await fetch(`${PORTAL_API}/v1/auth/mcp-session/${encodeURIComponent(sessionId)}`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Tool registration ──

function registerTools(server, z, sessionState, getSessionId) {
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
      'Then call portal_login_check ONCE with the device_code — it waits up to 2 min for approval automatically.',
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
      'Wait for login approval after portal_login returned a device_code.',
      'This tool polls the server automatically for up to 2 minutes.',
      'Call it ONCE after opening the browser — it will return when the user signs in or after timeout.',
      'No need to call repeatedly.',
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

      const LOGIN_POLL_TIMEOUT = 120_000;
      const LOGIN_POLL_INTERVAL = 3_000;
      const start = Date.now();

      while (Date.now() - start < LOGIN_POLL_TIMEOUT) {
        try {
          const res = await fetch(`${PORTAL_API}/v1/auth/device/token?device_code=${device_code}`);
          const data = await res.json();

          if (data.status === 'approved' && data.api_key) {
            sessionState.apiKey = data.api_key;
            sessionState.email = data.email;
            const sid = getSessionId?.();
            if (sid) persistSession(sid, data.api_key, data.email);
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

          if (data.status === 'expired') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'expired',
                  message: 'Authorization expired. Run portal_login again.',
                }, null, 2),
              }],
            };
          }
        } catch {
          // Network blip — keep polling
        }
        await new Promise(r => setTimeout(r, LOGIN_POLL_INTERVAL));
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'timeout',
            message: 'Waited 2 minutes but user has not signed in yet. Call portal_login_check again if the user is still signing in, or portal_login to start over.',
          }, null, 2),
        }],
      };
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
      'DECISION TREE — two questions:',
      '',
      '  Q1: Does the site need sign-in?',
      '    YES → save_login → user logs in, presses Save → poll get_session → saved_state_id',
      '          (Hosted UI prompts user to store credentials for auto re-login — handled in browser)',
      '    NO → skip to Q2',
      '',
      '  Q2: Record yourself or let AI generate?',
      '    RECORD → record_demo → user clicks around, presses Stop → poll get_session → compiled scenes',
      '    AI GENERATE → create_script → poll get_script → draft scenes',
      '',
      '  Then REVIEW the draft with the user:',
      '    1. Watch mode (guided demo) or play mode (free browse)?',
      '    2. Scenes (narration + actions)',
      '    3. Example Q&A (verify AI answers)',
      '    4. Blocked selectors + allowed URLs',
      '    5. Greeting + knowledge',
      '    6. Final confirmation → make_portal',
      '',
      'After checking status:',
      '- Not authenticated → call portal_login, then poll portal_login_check.',
      '- Authenticated → determine user intent and follow Q1/Q2 above.',
      '',
      'Other tools:',
      '  "Show my portals" → list_portals — check for existing portals before creating duplicates.',
      '  "Store credentials" → create_credential.',
      '',
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
      'Create a Portal. Validates internally — do NOT call validate_ptl first.',
      'Returns a shareable URL to a live, sandboxed browser session.',
      'Costs 1 credit. Session TTL is 10 min from when a viewer opens the link.',
      '',
      'IMPORTANT:',
      '  - This tool validates the spec internally. Do NOT call validate_ptl or normalize_ptl separately.',
      '  - May return "provisioning" if pool is cold. Poll get_portal every 15s for up to 5 min.',
      '  - NEVER create a second portal if one is still provisioning. That wastes credits.',
      '  - Give user status updates while waiting.',
      '  - When ready, open the URL in the user\'s browser automatically.',
      '',
      'FOR WATCH MODE:',
      '  Prefer using create_script to auto-generate scenes (better quality than writing them yourself).',
      '  You MUST have shown the scenes to the user and gotten approval BEFORE calling this.',
      '  If you haven\'t shown scenes yet, do that first. Do NOT call this tool with watch mode',
      '  scenes the user hasn\'t reviewed.',
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
    'list_portals',
    [
      'List the user\'s recent portals (up to 20, newest first).',
      '',
      'Use this to check if a portal already exists for the same URL before creating a new one.',
      'Also useful for the user to re-open or share a previous portal.',
    ].join('\n'),
    {},
    async () => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', '/v1/portals', undefined, key);
    }
  );

  server.tool(
    'save_login',
    [
      'Start a login capture session. Opens a sandboxed browser at the given URL.',
      'Returns a hosted_url + session_id.',
      '',
      'Tell the user to open the hosted_url in their browser and log in normally.',
      'The user presses the Save button in the hosted UI when done — do NOT wait for them to tell you verbally.',
      'Instead, poll get_session with the session_id every 5 seconds.',
      'When status changes to "ready", the login state is saved and the response includes saved_state_id.',
      '',
      'Flow: save_login → user opens hosted_url → logs in → presses Save → poll get_session → saved_state_id',
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
    [
      'Save the login state after the user has logged in via the hosted UI.',
      '',
      'After save completes, the hosted UI shows a "Keep this Portal logged in?" prompt',
      'where the user can optionally store credentials for auto re-login.',
      'This is handled entirely in the hosted UI — do NOT ask about credentials yourself.',
      '',
      'The response includes saved_state_id which you carry forward to record_demo or create_script.',
    ].join('\n'),
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
      'Most accurate way to generate a script because the user shows exactly what they want.',
      '',
      'Returns a hosted_url + session_id.',
      'Tell the user to open the hosted_url, click through the demo they want, then press the Stop button in the hosted UI.',
      'Do NOT wait for the user to tell you verbally. Instead, poll get_session every 5 seconds.',
      'When status changes to "compiled", the recording is done and compiled scenes are in the response.',
      '',
      'After compilation, present the FULL review to the user:',
      '  1. Watch mode or play mode?',
      '  2. Formatted scenes (narration + actions)',
      '  3. Example Q&A (verify AI answers are accurate)',
      '  4. Blocked selectors + allowed URLs',
      '  5. Greeting + knowledge',
      'Then call make_portal after user approves.',
      '',
      'Flow: record_demo → user opens hosted_url → clicks around → presses Stop → poll get_session → review → make_portal',
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
    [
      'Stop recording and compile the demo into structured scenes.',
      'Returns compiled scenes with narration, actions, selectors, and Q&A.',
      'Present the FULL review to the user (same as get_script review checklist):',
      '  mode choice, scenes, example Q&A, selectors, greeting, knowledge.',
      'Then call make_portal after user approves.',
    ].join('\n'),
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/stop`, {}, key);
    }
  );

  server.tool(
    'get_session',
    [
      'Poll the status of a login or recording session.',
      '',
      'Login session statuses:',
      '  "awaiting_login" → user has not saved yet, keep polling',
      '  "saving" → save in progress',
      '  "ready" → login saved, saved_state_id is in the response',
      '  "save_failed" → save failed, tell user to try again',
      '',
      'Recording session statuses:',
      '  "awaiting_recording" → user has not started yet',
      '  "recording" → user is clicking around',
      '  "compiling" → stop was pressed, scenes being compiled',
      '  "compiled" → done, compiled scenes are in the response as "script"',
      '  "compile_failed" → compilation failed',
      '',
      'Poll every 5 seconds. The user presses buttons in the hosted UI to trigger transitions.',
    ].join('\n'),
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
      '  - Public URL (no saved_state_id): Fast (~10s). Fetches page content and generates scenes via LLM.',
      '  - With saved_state_id: Experimental (~60-120s). Opens headless browser with saved login, explores interactively.',
      '',
      'Returns script_id. Poll get_script every 5-15s until status is "draft".',
      '',
      'The draft includes scenes, example_qa, blocked_selectors, allowed_urls, greeting, and knowledge.',
      'Present ALL of these to the user for review (see get_script for the full review checklist).',
      'The user picks watch mode (guided demo) or play mode (free browse) during review.',
      'After approval, call make_portal.',
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
      '',
      'When status is "draft", present a COMPLETE review to the user before creating the portal:',
      '',
      '1. MODE SELECTION: Ask "Should this be a guided demo (watch mode) or free-browse (play mode)?"',
      '   Watch = agent leads with scenes. Play = viewer explores freely with AI copilot.',
      '',
      '2. SCENES (watch mode): Show each scene formatted clearly:',
      '   Scene 1: [name]',
      '     "[narration text]"',
      '     Actions: scroll down, click "Pricing", wait 2s',
      '   Ask: "Want to edit, reorder, or remove any scenes?"',
      '',
      '3. EXAMPLE Q&A: If example_qa is present, show each Q&A pair:',
      '   Q: "What does this product do?" → A: "..." (source: page_content)',
      '   Ask: "Are these answers accurate? Anything the AI should answer differently?"',
      '',
      '4. SELECTORS: Show blocked_selectors and allowed_urls:',
      '   Blocked: a[href="/login"] (auth flow), .cookie-banner (consent)',
      '   Allowed: example.com/*, example.com/pricing',
      '   Ask: "Should anything else be blocked or allowed?"',
      '',
      '5. GREETING + KNOWLEDGE: Show the AI greeting and knowledge summary.',
      '',
      '6. CONFIRM: "Ready to create the portal? This uses 1 credit."',
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

  server.tool(
    'buy_credits',
    [
      'Purchase Portal creation credits. Opens a Stripe checkout page.',
      'Each credit = one Portal creation ($0.40/credit).',
      '',
      'Packs:',
      '  starter — 10 credits for $4',
      '  builder — 50 credits for $20',
      '  pro     — 100 credits for $40',
      '',
      'Returns a checkout_url. Open it in the user\'s browser immediately:',
      '  macOS: open "https://..."',
      '  Linux: xdg-open "https://..."',
      '',
      'After payment, credits are added automatically. Call portal_status to verify.',
    ].join('\n'),
    {
      pack_id: z.enum(['starter', 'builder', 'pro']).describe('Credit pack: starter (10/$4), builder (50/$20), pro (100/$40)'),
    },
    async ({ pack_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/auth/credits/checkout', { pack_id }, key);
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

    // Try restoring a persisted session (survives server restarts)
    let restoredState = null;
    if (existingSessionId) {
      restoredState = await restoreSession(existingSessionId);
      if (restoredState) {
        console.log(`[Session] Restored persisted session for ${restoredState.email || 'unknown'}`);
      }
    }

    const auth = req.headers.authorization;
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    const sessionState = {
      apiKey: restoredState?.api_key || bearerToken,
      email: restoredState?.email || null,
    };
    let capturedSessionId = existingSessionId || null;
    const getSessionId = () => capturedSessionId;
    const server = new McpServer({ name: 'portal-mcp', version: '1.0.0' });
    registerTools(server, z, sessionState, getSessionId);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        if (!capturedSessionId) capturedSessionId = crypto.randomUUID();
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
