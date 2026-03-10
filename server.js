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
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS, 10) || 4 * 60 * 60 * 1000;
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
        status: 'not_authenticated',
        action: 'call portal_login',
        message: 'Not signed in yet. Call the portal_login tool to authenticate — it returns a browser link for one-time Google sign-in.',
      }, null, 2),
    }],
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
      'Sign in to Portal. Returns a verification_url and device_code.',
      '',
      'After this tool returns, do these steps IN ORDER:',
      '  Step 1 (REQUIRED FIRST): Run a shell command to open the browser:',
      '    macOS: open "VERIFICATION_URL"',
      '    Linux: xdg-open "VERIFICATION_URL"',
      '    Windows: start "VERIFICATION_URL"',
      '  Step 2 (ONLY after step 1): Call portal_login_check with the device_code.',
      '',
      'CRITICAL: You MUST open the browser BEFORE calling portal_login_check.',
      'portal_login_check polls for 30s. If the user hasn\'t signed in, call it again.',
      'Do NOT ask the user if they signed in — the check tool handles the wait.',
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
              instructions: 'Step 1: Run shell command to open the verification_url in the browser. Step 2: AFTER the browser opens, call portal_login_check with the device_code above.',
              shell_command: 'open "' + deviceData.verification_url + '"',
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
      'This tool polls for up to 30 seconds, then returns.',
      'IMPORTANT: Only call AFTER you have opened the browser with the verification_url.',
      'If status is "pending", call this tool again (the user is still signing in).',
      'Repeat up to 8 times (4 min total). Do NOT ask the user — just keep calling silently.',
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

      const LOGIN_POLL_TIMEOUT = 30_000;
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
            message: 'User has not signed in yet. Call portal_login_check again immediately — do NOT ask the user. Keep calling until authenticated (up to 8 times total, 4 min).',
            auto_proceed: true,
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
      'NODE B — Mode selection:',
      '  B1: Watch — Record self → record_demo (hosted URL, user records, stop_recording).',
      '  B2: Watch — AI script → create_script (public: HTTP fetch; auth: vm_single_page CDP grab, NO navigation).',
      '  B3: Play — AI selectors (beta) → I\'ll find the selectors to block on the page you request, users click around.',
      '  B4: Play — User selectors → pick_selectors (hosted URL, user clicks elements, pick_selectors_complete).',
      '  B5: Not sure → offer ALL 4 options in one question.',
      '  NEVER autonomously navigate authenticated sites. Auth sites get single-page grab only.',
      '',
      'NODE C — Quick review + naming, then deploy (1 credit):',
      '  Show the user a summary of what you\'re deploying:',
      '    Watch: scenes + greeting + example Q&A.',
      '    Play: blocked selectors + greeting + allowed URLs + knowledge.',
      '  Then ask: "What do you want to call this? Look good to go?"',
      '  Once the user names it (or says go), call make_portal immediately.',
      '  Auto-open the portal URL in the browser when ready.',
      '',
      'NODE D — Post-deploy:',
      '  Say: "Check it out! Happy to tweak it, or if you\'d like:"',
      '  - Give a snippet to test embedding on your site (configure_embed + console one-liner)',
      '  - Make share links (configure_portal for labels/limits)',
      '  - Check session replays (get_portal_sessions)',
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
    { ptl: z.object({}).passthrough().describe('Portal spec object (see make_portal for schema)') },
    async ({ ptl }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/ptl/normalize', { ptl }, key);
    }
  );

  server.tool(
    'validate_ptl',
    'Validate a .ptl Portal spec without creating a portal.',
    { ptl: z.object({}).passthrough().describe('Portal spec object (see make_portal for schema)') },
    async ({ ptl }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/ptl/validate', { ptl }, key);
    }
  );

  server.tool(
    'make_portal',
    [
      'STOP: You MUST show the user a draft summary (greeting, selectors, mode, URL) and ask for a name BEFORE calling this tool.',
      'If you have not done that yet, do it now instead of calling make_portal.',
      '',
      'Create a Portal and get a shareable link (1 credit). Returns a URL to a live, sandboxed browser session — 10 min per viewer.',
      '',
      'Validates the spec internally — do NOT call validate_ptl or normalize_ptl first.',
      'May return "provisioning" — poll get_portal every 15s for up to 5 min. Never create a second portal while one is provisioning.',
      'When ready, open the URL in the user\'s browser automatically.',
      '',
      'For watch mode: prefer create_script for scene quality.',
      'Set ptl.slug to a URL-friendly name (e.g. "reddit-demo"). This becomes the URL path: makeportals.com/demo/{slug}/...',
      'If the user gave a name at Node C, slugify it (lowercase, hyphens, no spaces). Auto-generate from site name if none given.',
      'After deploying, open the URL and say "Check it out! Happy to tweak it." Offer embedding/links/replays.',
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
      '    Advanced: use "scenes" instead for actions: [{script, actions: [{action, selector?, inner_text?, ms?}]}]',
      '    Actions: click (selector + inner_text for fallback), scroll_up, scroll_down, scroll_to_element (selector), wait (ms), type (selector + inner_text)',
      '    IMPORTANT: When copying scenes from create_script, pass ALL fields including inner_text — it is the click fallback when CSS selector fails.',
      '',
      '  ptl.entry.framework — for local_file: deployment preset. Values: vite, cra, html, serve, next, react-express, vite-express, react-python, python-backend',
      '    react-express  → /client (npm start :3000) + /server (node server.js :3001)',
      '    vite-express   → /client (npm run dev :5173) + /server (node server.js :3001)',
      '    react-python   → /client (npm run dev :5173) + /server (pip install, python server.py :8000)',
      '    python-backend → / (pip install -r requirements.txt, python server.py :8000)',
      '    Multi-service presets expect /client + /server subdirs in the zip. If your project uses /frontend + /backend, rename before zipping or restructure.',
      '',
      '  ptl.guardrails.allowed_urls — URLs the user can visit in play mode (array of strings)',
      '  ptl.guardrails.blocked_selectors — CSS selectors to disable (e.g. "#delete-account", ".danger-zone"). ONLY use selectors from a real DOM snapshot — never guess.',
      '  ptl.guardrails.apis — API blocking: { blocked: ["DELETE /api/account"], block_uploads: true }',
      '  ptl.guardrails.api_rules.rate_limits — rate limit specific API calls (array of objects):',
      '    [{ name: "Chat API", pattern: "/api/chat", method: "POST", max: 5, windowMs: 60000 }]',
      '    pattern: substring match on URL. method: ANY/GET/POST/PUT/PATCH/DELETE. max: calls per window. windowMs: window in ms.',
      '    Enforced at browser level via CDP — returns 429 when exceeded. No backend changes needed.',
      '',
      'Minimal example: { entry: { url: "https://example.com" }, experience: { mode: "play" } }',
      '',
      'For LOCAL FILES: zip the project and base64 encode in ONE step, then pass inline:',
      '  rm -f /tmp/app.zip && cd /path/to/project && zip -r /tmp/app.zip . -x "node_modules/*" "*/node_modules/*" ".git/*" "dist/*" "package-lock.json" "*/package-lock.json" "*.lock"',
      '  Then call make_portal using a shell tool to build the JSON with the base64 inline:',
      '  B64=$(base64 -i /tmp/app.zip) && curl or pass B64 variable directly as ptl.entry.local_file.',
      '  IMPORTANT: Do NOT read/cat the base64 file into your context. Pass the base64 string directly as the local_file value in one step.',
      '',
      'For CHROME EXTENSIONS: zip the unpacked extension directory (manifest.json MUST be at the zip root, NOT nested in a subfolder).',
      '  cd /path/to/extension && zip -r /tmp/ext.zip . -x ".git/*"',
      '  B64=$(base64 -i /tmp/ext.zip)',
      '  Pass B64 as ptl.entry.chrome_extension (or entry.type="chrome_extension" + entry.source=B64).',
      '  ALSO set entry.url to the site the extension should run on (e.g. "https://nytimes.com").',
      '  Use guardrails.allowed_urls to restrict which sites users can navigate to in the Portal.',
      '',
      'For authenticated sites: pass saved_state_id from save_login so the portal VM loads the logged-in session.',
      '',
      'TIP: To quickly demo rate limiting without building an app, use deploy_example with example="rate-limit-demo".',
    ].join('\n'),
    {
      name: z.string().describe('Portal name (e.g. "Reddit Demo", "Acme Product Tour"). Ask the user or auto-generate from the site/content.'),
      slug: z.string().optional().describe('URL slug (e.g. "reddit-demo"). Becomes makeportals.com/demo/{slug}/... — lowercase, hyphens, no spaces. Auto-generated from name if omitted.'),
      ptl: z.object({}).passthrough().describe('Portal spec object — must include entry.url and experience.mode at minimum'),
      saved_state_id: z.string().optional().describe('Saved login state from save_login — portal VM will load this session'),
      idempotency_key: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ name, slug, ptl, saved_state_id, idempotency_key, dry_run }) => {
      const key = getKey();
      if (!key) return authError();
      if (!name || typeof name !== 'string' || !name.trim()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'name_required',
              message: 'A portal name is required. Ask the user what they want to call this portal, or auto-generate a name from the site content.',
            }, null, 2),
          }],
          isError: true,
        };
      }
      if (slug && !ptl.slug) {
        ptl.slug = slug;
      }
      const idem = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { name: name.trim(), ptl, saved_state_id, idempotency_key: idem, dry_run }, key);
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
      'Name a portal, set usage limits, and add a call-to-action button.',
      'Auto-refill stays enabled. The user can adjust further in the web UI.',
      'Call after make_portal to customize the link before sharing.',
      'The URL slug is set at creation time via ptl.slug (e.g. makeportals.com/demo/{slug}/{code}).',
    ].join('\n'),
    {
      portal_id: z.string().describe('Portal ID (e.g. ptl_...)'),
      name: z.string().optional().describe('Display name for this portal (e.g. "Stripe Demo for Sales")'),
      label: z.string().optional().describe('Label for the share link (e.g. "outbound-email-feb")'),
      max_uses: z.number().optional().describe('Max viewer uses (0 = unlimited). Auto-refill stays on.'),
      cta_text: z.string().optional().describe('Call-to-action button text (e.g. "Book a Demo", "Start Free Trial")'),
      cta_url: z.string().optional().describe('Call-to-action button URL (e.g. "https://calendly.com/your-link")'),
    },
    async ({ portal_id, name, label, max_uses, cta_text, cta_url }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/portals/${encodeURIComponent(portal_id)}/configure`, { name, label, max_uses, cta_text, cta_url }, key);
    }
  );

  server.tool(
    'configure_embed',
    [
      'Enable embedding for a portal on a specific website.',
      'Ask the user what site they want to embed on (e.g. "https://yoursite.com").',
      'Returns the embed URL, an <iframe> snippet, and a console_snippet.',
      'The console_snippet is a browser-console-friendly script (short lines, no template literals).',
      'Give the user the console_snippet value in a code block — they paste it into DevTools console to preview.',
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
      'Spin up a Portal sandbox so the user can sign into a site in the hosted UI.',
      'Tell the user: "Sounds great, let me spin up a Portal sandbox so you can sign into [site] in the hosted UI."',
      'After this returns, in your next tool call batch:',
      '  1. Run shell: open "HOSTED_URL" (macOS) | xdg-open (Linux) | start (Windows)',
      '  2. Call get_session with the session_id to start polling',
      'Then poll get_session every 10s in a LOOP for up to 5 min. NEVER stop to ask the user.',
      'Do NOT say "let me know when you\'re done" — just keep polling silently.',
      'When status is "ready", the login is saved. Proceed immediately to the next step.',
      'When status is "ready" and credentials_stored is true, a credential vault entry was also saved.',
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
        data.instructions = `In your NEXT tool call batch: (1) run shell: open "${data.hosted_url}" and (2) call get_session to start polling. Then keep polling every 10s until status is "ready". NEVER ask the user if they saved.`;
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
      'Record a demo by clicking through a site. After this returns, in your next tool call batch:',
      '  1. Run shell: open "HOSTED_URL" (macOS) | xdg-open (Linux) | start (Windows)',
      '  2. Call get_session with the session_id to start polling',
      'Then poll get_session every 10s in a LOOP for up to 10 min. NEVER stop to ask the user.',
      'Do NOT say "let me know when you\'re done" — just keep polling silently.',
      'Status flow: awaiting_recording → recording → compiling → compiled.',
      'When "compiled", present the full review (scenes, Q&A, selectors, greeting) and get approval before make_portal.',
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
        data.message = `In your NEXT tool call batch: (1) run shell: open "${data.hosted_url}" and (2) call get_session to start polling. Then keep polling every 10s until status is "compiled". NEVER ask the user if they recorded.`;
        data.auto_proceed = true;
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
      'Show the user the compiled scenes/greeting/Q&A.',
      'Ask: "What do you want to call this? Look good to go?"',
      'Once confirmed, call make_portal. After deploying, say "Check it out!" and offer tweaks/embedding/replays.',
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
      'After this returns, in your next tool call batch:',
      '  1. Run shell: open "HOSTED_URL" (macOS) | xdg-open (Linux) | start (Windows)',
      '  2. Call get_session with the session_id to start polling',
      'Then poll get_session every 5s in a LOOP for up to 5 min. NEVER stop to ask the user.',
      'Do NOT say "click Done when finished" — just keep polling silently.',
      'When status is "selectors_saved", show the user which selectors were picked.',
      'Ask: "What do you want to call this? Look good to go?"',
      'Once confirmed, call make_portal. After deploying, say "Check it out!" and offer tweaks/embedding/replays.',
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
        data.message = `In your NEXT tool call batch: (1) run shell: open "${data.hosted_url}" and (2) call get_session to start polling. Then keep polling every 5s until status is "selectors_saved". NEVER ask the user if they're done.`;
        data.auto_proceed = true;
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
      'Show the user the selectors. Ask: "What do you want to call this? Look good to go?"',
      'Once confirmed, call make_portal. After deploying, say "Check it out!" and offer tweaks/embedding/replays.',
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
      'Wait for a login, recording, or selector session to reach a terminal status.',
      'This tool polls the server for up to 30 seconds, then returns.',
      'If status is still pending, call this tool again immediately — do NOT ask the user.',
      'Repeat up to 10 times (5 min total). The user is working in the hosted browser.',
      '',
      'Terminal statuses (stop polling):',
      '  "ready" — login saved, saved_state_id in response',
      '  "save_failed" — save failed',
      '  "compiled" — recording compiled, scenes in response',
      '  "compile_failed" — compilation failed',
      '  "selectors_saved" — selectors picked, array in response',
      '',
      'Pending statuses (keep calling):',
      '  "awaiting_login", "saving", "awaiting_recording", "recording", "compiling", "awaiting_selection"',
    ].join('\n'),
    { session_id: z.string().describe('Session ID from save_login, record_demo, or pick_selectors') },
    async ({ session_id }) => {
      const key = getKey();
      if (!key) return authError();

      const SESSION_POLL_TIMEOUT = 30_000;
      const SESSION_POLL_INTERVAL = 3_000;
      const terminalStatuses = new Set([
        'ready', 'save_failed',
        'compiled', 'compile_failed',
        'selectors_saved',
      ]);

      const start = Date.now();
      let lastResult;

      while (Date.now() - start < SESSION_POLL_TIMEOUT) {
        lastResult = await apiCall('GET', `/v1/sessions/${encodeURIComponent(session_id)}`, undefined, key);

        try {
          const data = JSON.parse(lastResult.content[0].text);
          if (terminalStatuses.has(data.status)) {
            return lastResult;
          }
          if (data.code === 'expired' || data.code === 'not_found') {
            return lastResult;
          }
        } catch (_) {
          return lastResult;
        }

        if (lastResult.isError) {
          return lastResult;
        }

        await new Promise(r => setTimeout(r, SESSION_POLL_INTERVAL));
      }

      try {
        const data = JSON.parse(lastResult.content[0].text);
        data.auto_proceed = true;
        data.message = 'Still waiting — call get_session again immediately. Do NOT ask the user anything. Keep calling until a terminal status appears (up to 10 times / 5 min).';
        lastResult.content[0].text = JSON.stringify(data, null, 2);
      } catch (_) {}

      return lastResult;
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
      'When status is "draft", show the user the scenes/greeting/Q&A.',
      'Ask: "What do you want to call this? Look good to go?"',
      'Once confirmed, call make_portal. After deploying, say "Check it out!" and offer tweaks/embedding/replays.',
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
      '     When passing scenes to make_portal, copy ALL fields from each action (type/action, selector, inner_text).',
      '     inner_text is critical — it is the click fallback when CSS selectors fail on dynamic sites.',
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
      '',
      'If the user has a saved_state_id from save_login, pass it as golden_state_id to link the credential.',
      'Pass health_check_domain (e.g. "mail.google.com/inbox") so Portal can verify sessions are still logged in.',
      'If the account uses 2FA/Google Authenticator, ask the user for the TOTP base32 secret.',
    ].join('\n'),
    {
      name: z.string().describe('Label for this credential (e.g. "Acme — demo@acme.com")'),
      domain: z.string().describe('Domain (e.g. "github.com")'),
      values: z.object({
        username: z.string().optional().describe('Username or email for login'),
        email: z.string().optional().describe('Email for login (if different from username)'),
        password: z.string().optional().describe('Password for login'),
      }).passthrough().describe('Login field values'),
      totp_secret: z.string().optional().describe('TOTP base32 secret for 2FA (e.g. "JBSWY3DPEHPK3PXP")'),
      golden_state_id: z.string().optional().describe('saved_state_id from save_login — links credential to this saved session for auto re-login'),
      health_check_domain: z.string().optional().describe('URL to verify login is alive (e.g. "mail.google.com/inbox"). Portal re-logs-in if VMs drift from this URL.'),
      sso_provider: z.string().optional().describe('SSO provider if applicable (google, github, microsoft)'),
    },
    async ({ name, domain, values, totp_secret, golden_state_id, health_check_domain, sso_provider }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/credentials', { name, domain, values, totp_secret, golden_state_id, health_check_domain, sso_provider }, key);
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
    'generate_totp',
    [
      'Generate a TOTP 6-digit code from a stored credential vault entry.',
      'The credential must have a totp_secret. Returns the current code and seconds remaining.',
      'Use this when re-authenticating a session that requires 2FA.',
    ].join('\n'),
    {
      credential_id: z.string().describe('Credential vault entry ID'),
    },
    async ({ credential_id }) => {
      const key = getKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/credentials/${encodeURIComponent(credential_id)}/totp`, {}, key);
    }
  );

  server.tool(
    'delete_credential',
    'Delete a credential vault entry.',
    { credential_id: z.string().describe('Credential vault entry ID') },
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

  // ── Hardcoded example app: rate-limit demo ──────────────────────────────
  // Vite+React frontend (chat UI) + Express backend (mock LLM). ~6KB zipped.
  const EXAMPLE_RATE_LIMIT_DEMO_B64 = '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';

  server.tool(
    'deploy_example',
    [
      'Deploy a built-in example app to demonstrate a Portal feature.',
      '',
      'Available examples:',
      '  "rate-limit-demo" — React + Express chat app with a mock LLM backend.',
      '    Demonstrates Portal\'s API rate limiting: each chat message calls POST /api/chat.',
      '    Default: 5 calls/minute. After the limit, Portal\'s VM enforcer returns a synthetic 429.',
      '    No real API key needed — backend returns mock responses.',
      '',
      'The example is deployed as a Portal with a shareable link. Costs 1 credit.',
      'After deploying, open the URL and say "Try sending 6+ messages quickly to see the rate limit kick in."',
    ].join('\n'),
    {
      example: z.string().describe('Example name (e.g. "rate-limit-demo")'),
      name: z.string().optional().describe('Portal name (auto-generated if omitted)'),
      rate_limit_max: z.number().optional().describe('Override: max API calls per window (default 5)'),
      rate_limit_window_ms: z.number().optional().describe('Override: window duration in ms (default 60000 = 1 min)'),
    },
    async ({ example, name, rate_limit_max, rate_limit_window_ms }) => {
      const key = getKey();
      if (!key) return authError();

      if (example !== 'rate-limit-demo') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown example "${example}". Available: rate-limit-demo` }, null, 2) }],
          isError: true,
        };
      }

      const max = rate_limit_max || 5;
      const windowMs = rate_limit_window_ms || 60000;
      const portalName = name || 'Rate Limit Demo';

      const slug = `rate-limit-demo-${Date.now().toString(36)}`;
      const ptl = {
        version: 1,
        slug,
        entry: { type: 'local_file', framework: 'vite-express', local_file: EXAMPLE_RATE_LIMIT_DEMO_B64 },
        experience: {
          mode: 'play',
          agent: {
            enabled: true,
            interface: ['text'],
            greeting: `Welcome! This is a chat app with a ${max}-call-per-${Math.round(windowMs/1000)}s rate limit. Try sending ${max + 1}+ messages quickly to see Portal block the API call with a 429.`,
            knowledge: 'This app demonstrates Portal\'s API rate limiting. The frontend sends POST /api/chat on every message. The backend is a mock LLM that returns canned responses — no real API key. Portal\'s VM enforcer intercepts requests at the Chrome DevTools Protocol level and returns a synthetic 429 when the rate limit is exceeded.',
            goal: 'Let the user try the chat app and discover the rate limit naturally. Explain how Portal enforces it at the browser level with zero backend changes.',
          },
        },
        guardrails: {
          api_rules: {
            enabled: true,
            rate_limits: [
              { name: 'Chat API limit', pattern: '/api/chat', method: 'POST', max, windowMs },
            ],
          },
        },
      };

      return apiCall('POST', '/v1/portals', { name: portalName, ptl }, key);
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
