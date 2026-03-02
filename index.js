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
      const key = getApiKey();
      if (!key) return authError();
      const idemKey = idempotency_key || crypto.randomUUID();
      return apiCall('POST', '/v1/portals', { ptl, idempotency_key: idemKey, dry_run }, key);
    }
  );

  server.tool(
    'get_portal',
    'Get the current status of a portal by ID.',
    { portal_id: z.string() },
    async ({ portal_id }) => {
      const key = getApiKey();
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
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', '/v1/sessions/login', { url, name }, key);
    }
  );

  server.tool(
    'save_login_complete',
    'Save the login state after the user has logged in via the hosted UI.',
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
    'Stop recording and compile the demo into a structured script.',
    { session_id: z.string() },
    async ({ session_id }) => {
      const key = getApiKey();
      if (!key) return authError();
      return apiCall('POST', `/v1/sessions/${encodeURIComponent(session_id)}/stop`, {}, key);
    }
  );

  server.tool(
    'get_session',
    'Poll the status of a login or recording session.',
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
      'Generate a demo script for a website.',
      '',
      'Two paths:',
      '  - Public URL (no saved_state_id): Fast (~10s). Fetches page content and generates scenes via LLM.',
      '  - With saved_state_id: Experimental (~60-120s). Opens headless browser with saved login, explores interactively.',
      '',
      'Returns script_id. Poll get_script until status is "draft".',
      'Draft scenes are for REVIEW — present them to the user and ask if they want to edit before creating a portal.',
      '',
      'After the user approves scenes, use them in make_portal with mode "watch".',
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
      'Poll script generation status. Returns status_message with progress updates.',
      '',
      'Statuses: "generating" (in progress), "draft" (ready for review), "failed" (error).',
      'When status is "draft", present the scenes to the user for review/editing.',
      'Show each scene: name, script (narration), and actions.',
      'Ask: "Want to edit any scenes before creating the portal?"',
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
