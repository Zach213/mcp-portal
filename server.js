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

// ── Tool call logging (fire-and-forget to backend) ──

const SENSITIVE_TOOLS = new Set(['create_credential']);

function redactInput(toolName, input) {
  if (SENSITIVE_TOOLS.has(toolName) && input?.values) {
    return { ...input, values: '[REDACTED]' };
  }
  return input;
}

function logToolCall(sessionId, toolName, input, outputPreview, isError, durationMs, email) {
  if (!sessionId || !INTERNAL_SECRET) return;
  fetch(`${PORTAL_API}/v1/auth/mcp-log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': INTERNAL_SECRET,
    },
    body: JSON.stringify({
      session_id: sessionId,
      tool_name: toolName,
      input: redactInput(toolName, input),
      output_preview: outputPreview,
      is_error: isError,
      duration_ms: durationMs,
      user_email: email,
    }),
  }).catch(() => {});
}

function wrapWithLogging(server, sessionState, getSessionId) {
  const original = server.tool.bind(server);
  server.tool = (name, description, schema, handler) => {
    const wrapped = async (args) => {
      const start = Date.now();
      try {
        const result = await handler(args);
        const dur = Date.now() - start;
        const preview = result?.content?.[0]?.text?.slice(0, 500) || '';
        logToolCall(getSessionId?.(), name, args, preview, !!result?.isError, dur, sessionState.email);
        return result;
      } catch (err) {
        const dur = Date.now() - start;
        logToolCall(getSessionId?.(), name, args, err.message, true, dur, sessionState.email);
        throw err;
      }
    };
    return original(name, description, schema, wrapped);
  };
}

// ── Tool registration ──

function registerTools(server, z, sessionState, getSessionId) {
  wrapWithLogging(server, sessionState, getSessionId);
  const getKey = () => sessionState.apiKey || null;

  // ── Auth tools (always available) ──

  server.tool(
    'portal_login',
    [
      'Sign in to Portal. IMMEDIATELY run a shell command to open the verification_url — do NOT just print it.',
      'Use: open "URL" (macOS) | xdg-open "URL" (Linux) | start "URL" (Windows).',
      'Then call portal_login_check ONCE with the device_code — it auto-polls for up to 2 min.',
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
              message: 'Run a shell command NOW to open the verification_url: open "URL" (macOS), xdg-open "URL" (Linux), start "URL" (Windows). Do NOT just print the URL. Then call portal_login_check with the device_code.',
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
      'Check if you\'re signed in to Portal. Call this first — if not authenticated, run portal_login.',
      '',
      'Portal creates shareable links to live, sandboxed browser sessions for any website.',
      '',
      'AFTER AUTH, follow this flow:',
      '',
      'NODE A — Entry type classification:',
      '  A1: Needs auth (dashboards, admin, SaaS, settings) → call save_login.',
      '       User approves via tool dialog — don\'t ask separately. Auto-open hosted_url.',
      '       Poll get_session until saved_state_id returned. → proceed to B.',
      '  A2: Public (landing pages, docs, marketing) → proceed to B (no saved_state_id).',
      '  A3: Local file / localhost → zip directory (exclude node_modules/.git/dist),',
      '       base64 encode, pass as ptl.entry.local_file in make_portal.',
      '       For Chrome extensions: pass as ptl.entry.chrome_extension + entry.url for test site.',
      '  A4: Not sure → ASK: "Does [site] need you to be logged in?" Err on asking.',
      '',
      'NODE B — Mode selection (6 sub-nodes):',
      '  B1: Watch — Record self → record_demo (hosted URL, user records, stop_recording).',
      '  B2: Watch — AI script → create_script (public: HTTP fetch; auth: vm_single_page CDP grab, NO navigation).',
      '  B3: Play — AI selectors (beta) → create_script in play mode, LLM generates blocked_selectors. Tell user this is beta.',
      '  B4: Play — User selectors → pick_selectors (hosted URL, user clicks elements, pick_selectors_complete).',
      '  B5: Not sure → offer ALL 4 options in one question:',
      '       1. Watch — Record yourself giving the demo',
      '       2. Watch — Let AI generate a script',
      '       3. Play — Pick elements to block yourself',
      '       4. Play — Let AI decide what to block (beta)',
      '  NEVER autonomously navigate authenticated sites. Auth sites get single-page grab only.',
      '',
      'NODE C — Draft review (mandatory, never skip):',
      '  Watch draft: scenes + greeting + example_qa.',
      '  Play draft: blocked selectors + greeting + allowed URLs + knowledge.',
      '  If approved → make_portal → deploy → auto-open portal URL (1 credit). → Node D.',
      '  If rejected → back to Node B.',
      '',
      'NODE D — Post-deploy options:',
      '  D1: configure_portal → set label + max_uses for attribution link.',
      '  D2: configure_embed → set allowed_origin → returns <iframe> snippet.',
      '  D3: get_portal_sessions → conversation logs + signed recording URLs.',
      '  D4: Not happy → back to Node B.',
      '',
      'Other tools: list_portals, create_credential, buy_credits.',
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
            mcp_session_id: getSessionId?.() || null,
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
      'Create a Portal and get a shareable link (1 credit). Returns a URL to a live, sandboxed browser session — 10 min per viewer.',
      '',
      'Validates the spec internally — do NOT call validate_ptl or normalize_ptl first.',
      'May return "provisioning" — poll get_portal every 15s for up to 5 min. Never create a second portal while one is provisioning.',
      'When ready, open the URL in the user\'s browser automatically.',
      '',
      'For watch mode: prefer create_script for scene quality. You MUST show scenes to user and get approval before calling this.',
      '',
      'Schema (ALL fields nested under ptl object — matches makeportals.com/docs/portal-spec):',
      '',
      '  ptl.entry.url — where the browser opens (required for websites)',
      '  ptl.entry.local_file — base64-encoded zip of a local project (replaces url)',
      '  ptl.entry.chrome_extension — base64-encoded zip of unpacked extension (also set entry.url for the test site)',
      '',
      '  ptl.experience.mode — "play" (user explores) or "watch" (AI leads demo)',
      '  ptl.experience.agent.enabled — whether AI is present (default true)',
      '  ptl.experience.agent.greeting — what AI says when session opens',
      '  ptl.experience.agent.knowledge — docs/FAQ text the AI references',
      '  ptl.experience.agent.goal — what the AI should focus on (system prompt)',
      '  ptl.experience.agent.script — ordered list of what AI says, e.g. ["First...", "Now..."]',
      '    Advanced: use "scenes" instead for actions: [{script, actions: [{action, selector?, text?, ms?}]}]',
      '    Actions: click (selector), scroll_up, scroll_down, wait (ms), type (selector + text)',
      '',
      '  ptl.guardrails.allowed_urls — URLs the user can visit in play mode',
      '  ptl.guardrails.blocked_selectors — CSS selectors to hide (e.g. "#delete-account", ".danger-zone")',
      '  ptl.guardrails.apis — API blocking: { blocked: ["DELETE /api/account"], block_uploads: true }',
      '',
      'Minimal example: { entry: { url: "https://example.com" }, experience: { mode: "play" } }',
      '',
      'For LOCAL FILES: zip the project (exclude node_modules/.git/dist), base64 encode:',
      '  cd /path/to/project && zip -r /tmp/app.zip . -x "node_modules/*" ".git/*" "dist/*" && base64 -i /tmp/app.zip -o /tmp/app.b64',
      'Then pass the base64 string as ptl.entry.local_file.',
      '',
      'For CHROME EXTENSIONS: zip the unpacked extension (manifest.json at root), base64 encode,',
      'pass as ptl.entry.chrome_extension. Also set entry.url to the site to test on.',
      '',
      'For authenticated sites: pass saved_state_id from save_login so the portal VM loads the logged-in session.',
    ].join('\n'),
    {
      ptl: z.object({}).passthrough(),
      saved_state_id: z.string().optional().describe('Saved login state from save_login — portal VM will load this session'),
      idempotency_key: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ ptl, saved_state_id, idempotency_key, dry_run }) => {
      const key = getKey();
      if (!key) return authError();
      const idem = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, saved_state_id, idempotency_key: idem, dry_run }, key);
    }
  );

  server.tool(
    'get_portal',
    [
      'Check if a portal is ready. Returns "provisioning", "ready" (with URL), or "failed".',
      '',
      'Poll every 15s for up to 5 min — cold starts take time. When "ready", open the URL for the user.',
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
    'get_portal_sessions',
    [
      'Get session replays for a portal. Returns viewer sessions with conversation logs and signed recording URLs (10 min).',
      '',
      'If the user says "get me session replays for X", call list_portals first to find the matching portal_id,',
      'then call this tool. Show the user: session count, per-session message count, and recording URLs.',
      'Recording URLs expire in 10 minutes — tell the user to download or watch promptly.',
    ].join('\n'),
    { portal_id: z.string().describe('Portal ID (e.g. ptl_...)') },
    async ({ portal_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', `/v1/portals/${encodeURIComponent(portal_id)}/sessions`, undefined, key);
    }
  );

  server.tool(
    'configure_portal',
    [
      'Set a label and usage limit on a portal share link.',
      'Auto-refill stays enabled. The user can adjust further in the web UI.',
      'Call after make_portal to customize the link before sharing.',
    ].join('\n'),
    {
      portal_id: z.string().describe('Portal ID (e.g. ptl_...)'),
      label: z.string().optional().describe('Human-readable label for the link'),
      max_uses: z.number().optional().describe('Max viewer uses (0 = unlimited). Auto-refill stays on.'),
    },
    async ({ portal_id, label, max_uses }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/portals/${encodeURIComponent(portal_id)}/configure`, { label, max_uses }, key);
    }
  );

  server.tool(
    'configure_embed',
    [
      'Enable embedding for a portal on a specific website.',
      'Ask the user what site they want to embed on (e.g. "https://yoursite.com").',
      'Returns the embed URL and a ready-to-paste <iframe> snippet.',
    ].join('\n'),
    {
      portal_id: z.string().describe('Portal ID (e.g. ptl_...)'),
      allowed_origin: z.string().describe('The origin where the embed is allowed (e.g. "https://yoursite.com")'),
    },
    async ({ portal_id, allowed_origin }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/portals/${encodeURIComponent(portal_id)}/embed`, { allowed_origin }, key);
    }
  );

  server.tool(
    'save_login',
    [
      'Capture a login for a website. IMMEDIATELY run a shell command to open the hosted_url — do NOT just print it.',
      'Use: open "URL" (macOS) | xdg-open "URL" (Linux) | start "URL" (Windows).',
      'User logs in normally in the hosted browser and presses Save. Poll get_session every 10s.',
      'When status is "ready", the login state is saved. Do NOT wait for the user to tell you verbally.',
    ].join('\n'),
    {
      url: z.string().describe('The URL to navigate to for login'),
      name: z.string().optional().describe('Label for this saved login'),
    },
    async ({ url, name }) => {
      const key = getKey();
      if (!key) return authError();
      const result = await apiCall('POST', '/v1/sessions/login', { url, name }, key);
      const data = JSON.parse(result.content[0].text);
      if (data.hosted_url) {
        data.message = `Run a shell command NOW to open the hosted_url: open "${data.hosted_url}" (macOS), xdg-open (Linux), start (Windows). Do NOT just print the URL. Then poll get_session with the session_id every 10s until status is "ready".`;
        result.content[0].text = JSON.stringify(data, null, 2);
      }
      return result;
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
      'Record a demo by clicking through a site yourself. IMMEDIATELY run a shell command to open the hosted_url — do NOT just print it.',
      'Use: open "URL" (macOS) | xdg-open "URL" (Linux) | start "URL" (Windows).',
      'User clicks through the demo in the hosted browser, then presses Stop to compile scenes.',
      'Poll get_session every 10s. When "compiled", present scenes for review, then call make_portal.',
    ].join('\n'),
    {
      url: z.string().describe('The URL to record a demo on'),
      saved_state_id: z.string().optional().describe('ID of a saved login to pre-authenticate'),
      name: z.string().optional().describe('Label for this recording'),
    },
    async ({ url, saved_state_id, name }) => {
      const key = getKey();
      if (!key) return authError();
      const result = await apiCall('POST', '/v1/sessions/record', { url, saved_state_id, name }, key);
      const data = JSON.parse(result.content[0].text);
      if (data.hosted_url) {
        data.message = `Run a shell command NOW to open the hosted_url: open "${data.hosted_url}" (macOS), xdg-open (Linux), start (Windows). Do NOT just print the URL. Then poll get_session with the session_id every 10s until status is "compiled".`;
        result.content[0].text = JSON.stringify(data, null, 2);
      }
      return result;
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
    'pick_selectors',
    [
      'Open a hosted browser where the user visually clicks elements to block in play mode.',
      'IMMEDIATELY run a shell command to open the hosted_url — do NOT just print it.',
      'Use: open "URL" (macOS) | xdg-open "URL" (Linux) | start "URL" (Windows).',
      'User clicks elements in the browser → they appear as blocked selectors.',
      'User clicks Done when finished. Poll get_session every 5s until status is "selectors_saved".',
      'Then use the returned selectors as blocked_selectors in make_portal.',
    ].join('\n'),
    {
      url: z.string().describe('The URL to load for element selection'),
      saved_state_id: z.string().optional().describe('ID of a saved login if site needs auth'),
      name: z.string().optional().describe('Label for this session'),
    },
    async ({ url, saved_state_id, name }) => {
      const key = getKey();
      if (!key) return authError();
      const result = await apiCall('POST', '/v1/sessions/pick-selectors', { url, saved_state_id, name }, key);
      const data = JSON.parse(result.content[0].text);
      if (data.hosted_url) {
        data.message = `Run a shell command NOW to open the hosted_url: open "${data.hosted_url}" (macOS), xdg-open (Linux), start (Windows). Do NOT just print the URL. Then poll get_session with the session_id every 5s until status is "selectors_saved".`;
        result.content[0].text = JSON.stringify(data, null, 2);
      }
      return result;
    }
  );

  server.tool(
    'pick_selectors_complete',
    [
      'Retrieve the selectors the user picked in the hosted selector UI.',
      'Call this after get_session shows status "selectors_saved".',
      'Returns the selectors array to use as blocked_selectors in make_portal.',
    ].join('\n'),
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('GET', `/v1/sessions/${encodeURIComponent(session_id)}`, undefined, key);
    }
  );

  server.tool(
    'get_session',
    [
      'Poll the status of a login, recording, or selector session.',
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
      'Selector session statuses:',
      '  "awaiting_selection" → selector mode loading on VM',
      '  "selectors_saved" → user clicked Done, selectors array is in the response',
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
      'Explore a website and auto-generate demo scenes, selectors, guardrails, Q&A, and knowledge (~10s for public URLs).',
      '',
      'Returns script_id. Poll get_script every 5-15s until status is "draft".',
      'With saved_state_id: uses headless browser with saved login (~60-120s).',
      'Draft includes scenes, example_qa, blocked_selectors, allowed_urls, greeting, knowledge.',
      'Present all to user for review (see get_script). User picks watch or play mode. Then call make_portal.',
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
      'Check if a script is ready. Statuses: "generating", "draft" (ready for review), "failed".',
      '',
      'CRITICAL: When "draft", you MUST show ALL of these to the user. Do NOT skip any step:',
      '',
      '  1. MODE: "Should this be a guided demo (watch) or free-browse (play)?"',
      '  2. SCENES: Show EACH scene with its narration text + actions. Ask to edit/reorder/remove.',
      '  3. EXAMPLE Q&A: If example_qa exists, show EVERY Q&A pair formatted as:',
      '     Q: "question" → A: "answer"',
      '     Ask: "Are these answers accurate? Should the AI answer anything differently?"',
      '     DO NOT SKIP THIS — users need to verify AI answers before the portal goes live.',
      '  4. SELECTORS: Show blocked_selectors + allowed_urls. Ask if anything else to block/allow.',
      '  5. GREETING + KNOWLEDGE: Show the AI greeting and knowledge summary.',
      '  6. CONFIRM: "Ready to create the portal? This uses 1 credit."',
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
      'Buy Portal credits ($0.40 each). Starter: 10/$4, Builder: 50/$20, Pro: 100/$40. Opens Stripe checkout.',
      '',
      'Returns checkout_url — open it in the user\'s browser. Credits are added automatically after payment.',
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

  server.tool(
    'get_creation_logs',
    [
      'Retrieve the tool call log for an MCP session. Shows every tool called, inputs, outputs, errors, and timing.',
      '',
      'Use this to debug portal creation issues — see exactly what tools were called and what they returned.',
      'The current session\'s ID is in the portal_status response as mcp_session_id.',
      'If no session_id is provided, returns logs for the current session.',
    ].join('\n'),
    { session_id: z.string().optional().describe('MCP session ID (defaults to current session)') },
    async ({ session_id }) => {
      const sid = session_id || getSessionId?.();
      if (!sid) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No session ID available' }, null, 2) }],
          isError: true,
        };
      }
      try {
        const res = await fetch(`${PORTAL_API}/v1/auth/mcp-logs/${encodeURIComponent(sid)}`, {
          headers: { 'x-internal-secret': INTERNAL_SECRET },
        });
        const data = await res.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
      }
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

    // Stale or unknown session — every new transport requires 'initialize' first.
    // If the request isn't initialize, return 404 so the client reconnects.
    const body = Array.isArray(req.body) ? req.body : [req.body];
    const isInitialize = body.some(msg => msg?.method === 'initialize');

    if (existingSessionId && !isInitialize) {
      console.log(`[Session] Stale session ${existingSessionId.slice(0, 8)}… — forcing re-init`);
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session expired. Please reconnect.' },
        id: req.body?.id || null,
      });
      return;
    }

    // Try restoring persisted state (API key + email survive server restarts)
    let restoredState = null;
    if (existingSessionId) {
      restoredState = await restoreSession(existingSessionId);
      if (restoredState) {
        console.log(`[Session] Restored auth for ${restoredState.email || 'unknown'}`);
      }
    }

    const auth = req.headers.authorization;
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    const sessionState = {
      apiKey: restoredState?.api_key || bearerToken,
      email: restoredState?.email || null,
    };
    let capturedSessionId = null;
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
