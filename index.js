#!/usr/bin/env node
/**
 * index.js — Local MCP server for Portal (stdio transport)
 *
 * Run with: npx @makeportals/mcp
 * Or configure in your editor's MCP settings.
 *
 * Auth priority:
 *   1. PORTAL_API_KEY env var (override — for CI/headless)
 *   2. ~/.portal/credentials.json (persisted by portal_login tool)
 *   3. No auth (portal_login tool available to authenticate)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORTAL_API = (() => {
  const url = process.env.PORTAL_API_URL || 'https://generate-link-server-10sy.onrender.com';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      process.stderr.write(`[Portal] WARNING: PORTAL_API_URL uses non-HTTP scheme: ${parsed.protocol}\n`);
    }
  } catch {
    process.stderr.write(`[Portal] WARNING: PORTAL_API_URL is not a valid URL: ${url}\n`);
  }
  return url;
})();
const CREDENTIALS_DIR = path.join(os.homedir(), '.portal');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// ── Credential persistence ──

function readCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const stats = fs.statSync(CREDENTIALS_FILE);
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      process.stderr.write(`[Portal] WARNING: ${CREDENTIALS_FILE} has insecure permissions (${(stats.mode & 0o777).toString(8)}). Run: chmod 600 ${CREDENTIALS_FILE}\n`);
    }
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    if (data.api_key && typeof data.api_key === 'string' && data.api_key.startsWith('ptl_')) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCredentials(apiKey, email) {
  try {
    if (!fs.existsSync(CREDENTIALS_DIR)) {
      fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    }
    const data = { api_key: apiKey, email, created_at: new Date().toISOString() };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    process.stderr.write(`[Portal] Failed to save credentials: ${err.message}\n`);
    return false;
  }
}

function deleteCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
    return true;
  } catch {
    return false;
  }
}

function getApiKey() {
  if (process.env.PORTAL_API_KEY) return process.env.PORTAL_API_KEY;
  const creds = readCredentials();
  return creds?.api_key || null;
}

// ── API calls ──

async function apiCall(method, apiPath, body, bearerToken) {
  const url = `${PORTAL_API}${apiPath}`;
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
        message: 'Not authenticated with Portal. Please call the portal_login tool first to authorize.',
      }, null, 2),
    }],
    isError: true,
  };
}

// ── Device auth polling ──

async function pollForApproval(deviceCode) {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${PORTAL_API}/v1/auth/device/token?device_code=${deviceCode}`);
      const data = await res.json();

      if (data.status === 'approved' && data.api_key) {
        return data;
      }
      if (data.status === 'expired') {
        return { status: 'expired' };
      }
    } catch {
      // Network error, retry
    }
  }
  return { status: 'timeout' };
}

// ── Tool call logging (local JSONL files) ──

const LOCAL_SESSION_ID = `local_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const LOGS_DIR = path.join(CREDENTIALS_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, `${LOCAL_SESSION_ID}.jsonl`);

const SENSITIVE_TOOLS = new Set(['create_credential']);

function redactInput(toolName, input) {
  if (SENSITIVE_TOOLS.has(toolName) && input?.values) {
    return { ...input, values: '[REDACTED]' };
  }
  return input;
}

function logToolCall(toolName, input, outputPreview, isError, durationMs) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
    const entry = {
      tool_name: toolName,
      input: redactInput(toolName, input),
      output_preview: (outputPreview || '').slice(0, 500),
      is_error: isError,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Non-critical — don't break tool execution
  }
}

function readLocalLogs(sessionId) {
  const target = sessionId ? path.join(LOGS_DIR, `${sessionId}.jsonl`) : LOG_FILE;
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function listLocalSessions() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''))
    .sort()
    .reverse();
}

function wrapWithLogging(server) {
  const original = server.tool.bind(server);
  server.tool = (name, description, schema, handler) => {
    const wrapped = async (args) => {
      const start = Date.now();
      try {
        const result = await handler(args);
        const dur = Date.now() - start;
        const preview = result?.content?.[0]?.text?.slice(0, 500) || '';
        logToolCall(name, args, preview, !!result?.isError, dur);
        return result;
      } catch (err) {
        const dur = Date.now() - start;
        logToolCall(name, args, err.message, true, dur);
        throw err;
      }
    };
    return original(name, description, schema, wrapped);
  };
}

// ── Tool registration ──

function registerPortalTools(server, z) {
  wrapWithLogging(server);
  // Auth tools (always available)

  server.tool(
    'portal_login',
    [
      'Sign in to Portal. IMMEDIATELY run a shell command to open the verification_url — do NOT just print it.',
      'Use: open "URL" (macOS) | xdg-open "URL" (Linux) | start "URL" (Windows).',
      'Then poll portal_login_check with the device_code every 5 seconds until approved.',
      'New users get 3 creation credits + 10 view credits on first sign-up.',
    ].join('\n'),
    {},
    async () => {
      const existing = getApiKey();
      if (existing) {
        const creds = readCredentials();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'already_authenticated',
              email: creds?.email || 'unknown',
              message: 'Already authenticated with Portal. Use portal_logout to sign out first.',
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

        process.stderr.write(`\n[Portal] Open this URL to authorize:\n  ${deviceData.verification_url}\n\n  Verification code: ${deviceData.user_code}\n\n`);

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
      'Poll for login approval after portal_login returned a device_code.',
      'Returns approved + saves credentials locally, or pending/expired.',
      'Call this every few seconds until status is approved or expired.',
    ].join('\n'),
    { device_code: z.string().describe('The device_code from portal_login') },
    async ({ device_code }) => {
      const existing = getApiKey();
      if (existing) {
        const creds = readCredentials();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'already_authenticated',
              email: creds?.email || 'unknown',
            }, null, 2),
          }],
        };
      }

      try {
        const res = await fetch(`${PORTAL_API}/v1/auth/device/token?device_code=${device_code}`);
        const data = await res.json();

        if (data.status === 'approved' && data.api_key) {
          writeCredentials(data.api_key, data.email);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'authenticated',
                email: data.email,
                message: `Signed in as ${data.email}. Credentials saved to ~/.portal/credentials.json`,
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
    'Sign out of Portal and remove stored credentials.',
    {},
    async () => {
      const deleted = deleteCredentials();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: deleted,
            message: deleted ? 'Signed out of Portal. Credentials removed.' : 'No credentials found.',
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
      '       base64 encode, pass as ptl.entry.source in make_portal.',
      '       Set entry.type="local_file", entry.framework="vite"|"cra"|"html".',
      '       For Chrome extensions: entry.type="chrome_extension" + entry.url for test site.',
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
      const key = getApiKey();
      const creds = readCredentials();
      const source = process.env.PORTAL_API_KEY ? 'env' : (creds ? 'credentials_file' : 'none');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            authenticated: !!key,
            email: creds?.email || (process.env.PORTAL_API_KEY ? '(from PORTAL_API_KEY env)' : null),
            mcp_session_id: LOCAL_SESSION_ID,
            source,
            api_url: PORTAL_API,
          }, null, 2),
        }],
      };
    }
  );

  // Portal tools (require auth)

  server.tool(
    'normalize_ptl',
    'Normalize a .ptl Portal spec into canonical form.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => {
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/ptl/normalize', { ptl }, key);
    }
  );

  server.tool(
    'validate_ptl',
    'Validate a .ptl Portal spec without creating a portal.',
    { ptl: z.object({}).passthrough() },
    async ({ ptl }) => {
      const key = getApiKey();
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
      'Schema (ALL fields nested under ptl object):',
      '  ptl.entry.type ("single_site"|"local_file"|"chrome_extension") — default single_site',
      '  ptl.entry.url (required for single_site)',
      '  ptl.entry.source (required for local_file/chrome_extension — base64-encoded zip)',
      '  ptl.entry.framework ("vite"|"cra"|"html"|"serve") — for local_file, default html',
      '  ptl.experience.mode ("play"|"watch")',
      '  ptl.experience.agent.goal (required for watch)',
      '  ptl.experience.agent.greeting',
      '  ptl.experience.agent.scenes: [{script, actions: [{action, selector?, text?, ms?}]}]',
      '  ptl.guardrails.allowed_urls, ptl.guardrails.disabled_elements',
      '  Actions: click (selector), scroll_up, scroll_down, wait (ms), type (selector + text)',
      '  NO other top-level keys allowed — additionalProperties is strict.',
      '',
      'For LOCAL FILES: zip the project directory (exclude node_modules, .git, dist), base64 encode,',
      'and pass as ptl.entry.source. Shell example:',
      '  cd /path/to/project && zip -r /tmp/app.zip . -x "node_modules/*" ".git/*" "dist/*" && base64 -i /tmp/app.zip -o /tmp/app.b64',
      'Then read /tmp/app.b64 and pass as ptl.entry.source. Set ptl.entry.type to "local_file" and',
      'ptl.entry.framework to "vite", "cra", or "html". The zip MUST contain package.json (vite/cra)',
      'or index.html (html) at the top level or in a subdirectory.',
      '',
      'For CHROME EXTENSIONS: zip the unpacked extension (must contain manifest.json), base64 encode,',
      'pass as ptl.entry.source with type "chrome_extension". Also set entry.url to the site to test on.',
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
      const key = getApiKey();
      if (!key) return authError();
      const idemKey = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, saved_state_id, idempotency_key: idemKey, dry_run }, key);
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
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
      url: z.string().describe('URL to generate a script for'),
      saved_state_id: z.string().optional().describe('Saved login state for authenticated pages (triggers VM exploration)'),
      credential_id: z.string().optional().describe('Credential vault entry for auto-login'),
      goals: z.array(z.string()).optional().describe('What the demo should cover (e.g. "Show pricing page", "Highlight key features")'),
      max_pages: z.number().optional().describe('Max pages to visit (default 5)'),
    },
    async ({ url, saved_state_id, credential_id, goals, max_pages }) => {
      const key = getApiKey();
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
      const key = getApiKey();
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
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/credentials', { name, domain, values, totp_secret, sso_provider }, key);
    }
  );

  server.tool(
    'list_credentials',
    'List all credential vault entries (metadata only, no secrets).',
    {},
    async () => {
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('GET', '/v1/credentials', undefined, key);
    }
  );

  server.tool(
    'delete_credential',
    'Delete a credential vault entry.',
    { credential_id: z.string() },
    async ({ credential_id }) => {
      const key = getApiKey();
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
      const key = getApiKey();
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
      'Pass session_id="list" to see all available local sessions.',
    ].join('\n'),
    { session_id: z.string().optional().describe('MCP session ID, or "list" to see all sessions') },
    async ({ session_id }) => {
      if (session_id === 'list') {
        const sessions = listLocalSessions();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ sessions, count: sessions.length, log_dir: LOGS_DIR }, null, 2),
          }],
        };
      }
      const calls = readLocalLogs(session_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            session_id: session_id || LOCAL_SESSION_ID,
            call_count: calls.length,
            calls,
          }, null, 2),
        }],
      };
    }
  );
}

// ── Main ──

async function main() {
  const [serverMod, transportMod, zodMod] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod'),
  ]);

  const { McpServer } = serverMod;
  const { StdioServerTransport } = transportMod;
  const { z } = zodMod;

  const server = new McpServer({ name: 'portal-mcp', version: '1.0.0' });
  registerPortalTools(server, z);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const creds = readCredentials();
  if (creds) {
    process.stderr.write(`[Portal] Authenticated as ${creds.email}\n`);
  } else if (process.env.PORTAL_API_KEY) {
    process.stderr.write(`[Portal] Using PORTAL_API_KEY from environment\n`);
  } else {
    process.stderr.write(`[Portal] Not authenticated. Use the portal_login tool to sign in.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[Portal] Fatal: ${err.message}\n`);
  process.exit(1);
});
