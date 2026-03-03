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

// ── Tool registration ──

function registerPortalTools(server, z) {
  // Auth tools (always available)

  server.tool(
    'portal_login',
    [
      'Sign in to Portal via browser. Opens a Google sign-in page — approve to connect this editor.',
      '',
      'After receiving the verification_url, open it in the user\'s browser:',
      '  macOS: open "https://..."  |  Linux: xdg-open "https://..."  |  Windows: start "https://..."',
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
      'FLOW: One-shot first, then optionally improve.',
      '  1. Needs sign-in? → save_login (user logs in via hosted browser, presses Save)',
      '  2. make_portal from prompt → shareable link (1 credit)',
      '  3. Want to improve? → create_script (AI explores site) or record_demo (user records)',
      '  4. Review draft → configure Play/Watch, AI on/off, guardrails → rebuild portal',
      '',
      'Other tools: list_portals (check existing), create_credential (store login), buy_credits.',
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
      '  ptl.entry.url (required)',
      '  ptl.experience.mode ("play"|"watch")',
      '  ptl.experience.agent.goal (required for watch)',
      '  ptl.experience.agent.greeting',
      '  ptl.experience.agent.scenes: [{script, actions: [{action, selector?, text?, ms?}]}]',
      '  ptl.guardrails.allowed_urls, ptl.guardrails.disabled_elements',
      '  Actions: click (selector), scroll_up, scroll_down, wait (ms), type (selector + text)',
      '  NO other top-level keys allowed — additionalProperties is strict.',
    ].join('\n'),
    {
      ptl: z.object({}).passthrough(),
      idempotency_key: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ ptl, idempotency_key, dry_run }) => {
      const key = getApiKey();
      if (!key) return authError();
      const idemKey = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, idempotency_key: idemKey, dry_run }, key);
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
    'save_login',
    [
      'Capture a login for a website. Opens a hosted browser where the user logs in and presses Save — returns a saved_state_id.',
      '',
      'Tell the user to open the hosted_url and log in normally. Poll get_session every 5s.',
      'When status is "ready", the login state is saved. Do NOT wait for the user to tell you verbally.',
    ].join('\n'),
    {
      url: z.string().describe('The URL to navigate to for login'),
      name: z.string().optional().describe('Label for this saved login'),
    },
    async ({ url, name }) => {
      const key = getApiKey();
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
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/save`, {}, key);
    }
  );

  server.tool(
    'record_demo',
    [
      'Record a demo by clicking through a site yourself. Opens a hosted browser — you click around, then press Stop to compile scenes.',
      '',
      'Tell user to open hosted_url, click through what they want to demo, then press Stop.',
      'Poll get_session every 5s. When "compiled", present scenes for review, then call make_portal.',
    ].join('\n'),
    {
      url: z.string().describe('The URL to record a demo on'),
      saved_state_id: z.string().optional().describe('ID of a saved login to pre-authenticate'),
      name: z.string().optional().describe('Label for this recording'),
    },
    async ({ url, saved_state_id, name }) => {
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/sessions/record', { url, saved_state_id, name }, key);
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
      'When "draft", show the user a full review before creating the portal:',
      '  1. Mode: guided demo (watch) or free-browse (play)?',
      '  2. Scenes: show each scene with narration + actions. Ask to edit/reorder.',
      '  3. Q&A: show example_qa pairs. Ask if answers are accurate.',
      '  4. Selectors: show blocked_selectors + allowed_urls. Ask if anything else to block/allow.',
      '  5. Greeting + knowledge: show AI greeting and knowledge summary.',
      '  6. Confirm: "Ready to create the portal? This uses 1 credit."',
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
