# MCP Portal v1 Test Report — March 5, 2026

## Bug 1: `portal_login` → `portal_login_check` not called automatically

### What happened
Claude Code called `portal_login`, opened the browser, then **stopped and waited for the user** to say "im signed in" before calling `portal_login_check`. The agent sat idle for 1m 33s instead of immediately calling the polling tool.

### Expected behavior
After `portal_login` returns a device_code, the agent should immediately:
1. Open the browser (shell command)
2. Call `portal_login_check` (which auto-polls for 2 min)
3. NOT wait for user input — the tool handles the wait internally

### Root cause
The `portal_login` response message says:
> "Run a shell command NOW to open the verification_url... Then call portal_login_check with the device_code."

Claude Code (Sonnet 4.6) interpreted "then" as sequential-after-user-confirmation rather than sequential-in-same-turn. The agent defaulted to asking the user before proceeding because:
1. The instruction is in the tool *response*, not the tool *description* — agents weight descriptions more heavily
2. "Then call portal_login_check" doesn't explicitly say "do NOT wait for the user"
3. The agent's default behavior for auth flows is to confirm with the user

### Fix approach
Two-part fix:

**A. Strengthen the tool description** (not just the response message):
- `portal_login` description should say: "After opening the browser, IMMEDIATELY call portal_login_check in your very next tool call — do NOT wait for the user to confirm. The check tool polls automatically for 2 minutes."

**B. Strengthen the response message**:
- Add: "IMPORTANT: Call portal_login_check NOW — do NOT ask the user if they've signed in. The tool polls automatically and returns when auth succeeds."
- Add a structured field: `"next_tool": "portal_login_check"` and `"auto_proceed": true`

**C. Consider merging the tools** (longer-term):
- `portal_login` could open the device code flow, return the URL to open, then internally start polling. But MCP tool calls can't run for 2 minutes in most clients, so the split is necessary.

### Where to fix
- `/Users/zach/Downloads/mcp-portal/server.js` lines 215-268 (portal_login tool)

---

## Bug 2: analyzevisits.com portal — how did it get in?

### What happened
Claude Code created a portal for `analyzevisits.com/alerts.html` without any `saved_state_id` or credentials. The user asked how the portal showed the alerts page content.

### Answer
analyzevisits.com is a **public site** — no authentication required. Claude Code verified this by fetching all three pages and getting 200 OK:
- `analyzevisits.com` → 5KB (200 OK)
- `analyzevisits.com/dashboard.html` → 6.5KB (200 OK)
- `analyzevisits.com/alerts.html` → 13.5KB (200 OK)

The portal VM simply navigated to the public URL. No golden state, no credentials, no saved login. This is the standard public URL flow working correctly.

---

## All MCP Tools Test Results (via MCP protocol + REST API)

### Working correctly
| Tool | Via MCP | Via REST | Notes |
|---|---|---|---|
| `portal_login` | ✓ | N/A | Opens device auth flow, returns device_code |
| `portal_login_check` | ✓ | N/A | Polls 3s intervals, returns authenticated within seconds |
| `create_script` | ✓ | ✓ | 5 scenes, CSS selectors, narration, play_mode guardrails, 8 Q&A, greeting, knowledge |
| `get_script` | ✓ | ✓ | Full draft with all fields |
| `make_portal` | ✓ | ✓ | Creates portal + VM, returns URL. ~15-16s |
| `validate_ptl` | ✓ | ✓ | Validates + normalizes docs-style aliases |
| `normalize_ptl` | ✓ | ✓ | Converts all aliases correctly |
| `list_portals` | ✓ | ✓ | Returns all portals with metadata |
| `get_portal` | ✓ | ✓ | Returns portal status |
| `configure_portal` | ✓* | ✓ | *Bug: `name` param not destructured in handler — FIXED, pushed, awaiting redeploy |
| `get_portal_sessions` | ✓ | ✓ | Returns sessions (empty, no viewers yet) |
| `configure_embed` | ✓ | ✓ | Sets allowed origins, returns iframe snippet |

### Timing
| Operation | Latency |
|---|---|
| `create_script` kickoff | ~3s |
| Script generation (total) | 10-30s |
| `make_portal` (full deploy) | **15-16s** |
| `configure_portal` | ~2.4s |
| `list_portals` | ~1.7s |
| `get_portal_sessions` | ~2s |
| `validate_ptl` / `normalize_ptl` | ~1.7-1.9s |

### Script quality (tested on Notion, Stripe, Linear)
- 5 scenes each with meaningful narration text
- Real CSS selectors: `a[href='/product/custom-agents']`, `a[href='/pricing']`, `a[href='/developers']`
- Play mode auto-generated: 6-11 allowed URLs, 4 blocked selectors (auth/billing/download), knowledge, greeting, 8 Q&A
- ~10-30s total generation time

### Not yet tested
- Visual verification (VM boots, AI speaks, scenes play, selectors blocked)
- Authenticated site flows (save_login, golden state, credentials)
- Selector picker UI (pick_selectors)
- Recording flows (record_demo, start/stop_recording)
- scroll action in deployed portals
- Chrome extension portals (only tested local HTML)

### Known issues
- 5 portals stuck in "provisioning" with null URLs (failed deploys that never completed)
- `configure_portal` name bug (fixed, awaiting redeploy)
- Auth flow: agent doesn't auto-call `portal_login_check` (fixed, pushed)
- MCP session reconnection fails in Claude Code (see Bug 3 below)
- Multiple bugs found during real Claude Code user session (see Bug 4-14 below)

---

## Bug 3: MCP session dies after Render cold start — Claude Code can't reconnect

### What happened
Claude Code showed "reconnect" errors after the Render-hosted MCP server slept (free tier). The agent tried `claude mcp list` (empty output), curled the server (got "Missing or invalid session"), then told the user to run `/mcp` to reconnect manually.

### Root cause (server-side)
1. Sessions are stored **in-memory** (`const sessions = new Map()`) — line 52
2. Render free tier sleeps after ~15 min inactivity → server process restarts → Map is empty
3. When Claude Code sends the next request with old `mcp-session-id`, the server doesn't find it
4. Line 948-955: returns HTTP 404 with `"Session expired. Please reconnect."`

### Root cause (client-side)
5. Per MCP Streamable HTTP spec, clients receiving 404 SHOULD re-initialize automatically
6. Claude Code's MCP client **does not auto-reconnect** on 404 — it just shows the error
7. The Cursor MCP client handles this fine (tested successfully in this session)

### What already works
- `persistSession()` (line 125) saves `{api_key, email}` to the backend on successful login
- `restoreSession()` (line 141) fetches it back during re-initialization
- So if the client DID re-init, auth would be seamlessly restored — no re-login needed

### Fix options

**A. Keep Render warm (quick fix, costs money)**
- Upgrade from free tier, or add a cron ping to `/health` every 5 min
- Eliminates cold starts entirely

**B. Fix for Claude Code specifically (server-side workaround)**
- Instead of returning 404 for stale sessions, transparently create a new session:
  1. Create new McpServer + transport
  2. Restore persisted auth state
  3. Synthesize an `initialize` exchange internally
  4. Then handle the actual tool call
- Complexity: moderate — the MCP SDK transport expects `initialize` as first message

**C. Report to Anthropic (long-term)**
- Claude Code's MCP HTTP client should handle 404 by re-initializing, per spec
- Cursor already handles this correctly

### Where to fix
- `/Users/zach/Downloads/mcp-portal/server.js` lines 948-956 (stale session handler)
- Session store could use external storage (Redis, Firestore) instead of in-memory Map

---

## Bugs 4-14: Real Claude Code User Session (March 6, 2026)

Full test: user asked Claude Code to create signed-in portals for makeportals.com and stripe.com.
Tested save_login, pick_selectors, record_demo flows end-to-end.

### Master Bug Table

| # | Bug | Expected Behavior | Actual Behavior | Severity | Type | Root Cause File(s) |
|---|-----|-------------------|-----------------|----------|------|---------------------|
| 4 | **[object Object] as portal greeting** | Stripe portal shows AI narration text from recording | First message shows literal "[object Object]" | **P0** | Backend | `real_vm/manual_link_gen/lib/ptl-schema.js` line 338-342 |
| 5 | **Selector picker never activates** | Hosted UI shows element-selection overlay, user clicks to block | check-picked polls indefinitely, never detects picks | **P0** | VM/Extension | `real_vm/manual_link_gen/routes/mcp/hosted.js` line 245-317, VM recorder extension |
| 6 | **Agent doesn't auto-detect save completion** | Agent polls get_session until status="ready", then proceeds | Agent polls 3-4x, stops, asks user "did you save?" | **P1** | MCP tool desc | `mcp-portal/server.js` line 599-621 (save_login description) |
| 7 | **Agent doesn't auto-detect recording compilation** | Agent polls get_session until status="compiled", then proceeds | Agent polls once, stops, waits for user to say "I recorded" | **P1** | MCP tool desc | `mcp-portal/server.js` line 643-667 (record_demo description) |
| 8 | **portal_login "Invalid tool parameters"** | portal_login accepts {} and succeeds | Shows "Invalid tool parameters" alongside valid response | **P2** | MCP SDK/client | `mcp-portal/server.js` line 223 (schema: `{}`) |
| 9 | **Parallel tool call fails (login+check+bash)** | Agent calls portal_login, THEN bash+check sequentially | Agent fires all 3 in parallel, check cancelled because bash errored | **P1** | MCP tool desc | `mcp-portal/server.js` line 215-222 (portal_login description) |
| 10 | **429 on save-selectors** | Save selectors succeeds | Rate limit hit (429) because check-picked polling consumed the limit | **P2** | Backend rate limit | `real_vm/manual_link_gen/routes/mcp/hosted.js` line 17-22 |
| 11 | **get_session returns 10.4k tokens for recording** | Lightweight poll response during status checks | Full compiled_result (scenes, actions, narration) returned every poll | **P2** | Backend response | `real_vm/manual_link_gen/routes/mcp-sessions.js` line 384-386 |
| 12 | **No preview before deploy** | Agent shows summary/preview, asks "deploy?", then calls make_portal | Agent jumps straight from selectors to make_portal | **P1** | MCP flow/desc | `mcp-portal/server.js` pick_selectors_complete + portal_status descriptions |
| 13 | **Golden state ID exposed to user** | Response says "saved_state_1" or similar alias | Response shows raw ID "golden-1772761225265-vqgexem8p" | **P3** | UX | `real_vm/manual_link_gen/routes/mcp-sessions.js` line 382 |
| 14 | **Authorize page lacks Portal branding** | Authorize page shows Portal logo, branded UI | Generic page, no branding | **P3** | Frontend | `portal_landing/auth/src/` authorize page component |

---

### Bug 4: [object Object] as portal greeting — CRITICAL

**What happened:**
Claude Code recorded a Stripe demo, compiled 2 scenes, then called `make_portal` with:
```json
"script": [
  {"script": "Let me show you...", "actions": [{"action":"click","selector":"button.hds-button"}, ...]},
  {"script": "Now, I scroll down...", "actions": [{"action":"scroll_down"}, ...]}
]
```

**Root cause:**
`normalizePtl()` in `ptl-schema.js` line 338-342 handles the `script` → `scenes` alias conversion:
```javascript
if (Array.isArray(out.experience.agent.script) && !out.experience.agent.scenes) {
  out.experience.agent.scenes = out.experience.agent.script.map(s => ({
    script: typeof s === 'string' ? s : String(s),  // ← BUG
  }));
```
When `script` contains objects (structured scenes with actions), `String({...})` returns `"[object Object]"`.
The actions are also discarded — only the stringified narration survives.

**Correct behavior:**
If `script[i]` is an object with a `.script` property, treat it as an already-structured scene and pass through.
If `script[i]` is a string, wrap it in `{script: s}` as before.

**Fix (ptl-schema.js line 339-341):**
```javascript
out.experience.agent.scenes = out.experience.agent.script.map(s => {
  if (typeof s === 'string') return { script: s };
  if (typeof s === 'object' && s !== null && typeof s.script === 'string') return s;
  return { script: String(s) };
});
```

**Files:**
- `real_vm/manual_link_gen/lib/ptl-schema.js` — normalizePtl() line 338-342
- `real_vm/manual_link_gen/lib/ptl-to-draft.js` — downstream consumer of scenes

---

### Bug 5: Selector picker never activates

**What happened:**
1. User chose "Play — Pick elements to block yourself"
2. `pick_selectors` created a session, reused existing VM (`builder-1772761178166-xfwqd7`)
3. Hosted page opened, showed the site via LiveKit stream
4. `enable-selector` was called via hosted frontend (POST with 200 response)
5. But `check-picked` polling returned `{picked: false}` indefinitely — no elements were ever detected

**Root cause chain:**
1. During the golden state save (earlier flow), Chrome was restarted in agent mode
2. After restart, injection check showed: `⚠️ Recorder SW not found!`
3. The recorder extension's service worker failed to load after Chrome restart
4. Selector session reused this same VM — `Re-personalizing existing VM for editor mode...` wrote config with `mode: idle`
5. `enable-selector` sent `PORTAL_SET_MODE: editor` via CDP to the page
6. But with no recorder extension running, the `PORTAL_SET_MODE` message had no receiver
7. Element clicks were never intercepted → `element-picked` endpoint never called → `pickedElements` Map always empty → `check-picked` always returns `{picked: false}`

**Also contributing:**
- `PAGE_SNAPSHOT` error: `"timeout: failed to run command 'NODE_PATH=/usr/lib/node_modules': No such file or directory"` — node_modules path missing on VM

**Files:**
- `real_vm/manual_link_gen/routes/mcp/hosted.js` line 245-317 (enable-selector CDP script)
- `real_vm/manual_link_gen/routes/demo_recording.js` line 2035-2064 (element-picked handler)
- `real_vm/manual_link_gen/routes/demo_recording.js` line 2071-2097 (check-picked handler)
- VM provisioning/Chrome restart logic (recorder extension loading)

---

### Bug 6 & 7: Agent doesn't auto-detect save/record completion

**What happened (save_login):**
Agent polled get_session 4 times → saw "awaiting_login" → said "Still waiting for you to log in" → stopped polling → waited 49s → user said "ok i saved it" → agent polled again → saw "ready".

**What happened (record_demo):**
Agent called record_demo → opened hosted URL → polled once → said "Still waiting for you to start" → stopped → waited for user input → user said "try again" → user said "ok i recorded please deploy it".

**Root cause:**
Tool descriptions say to "poll get_session every 10s" but don't forcefully prevent the agent from asking the user. Claude Code's default behavior is to confirm with the user rather than silently polling.

`save_login` description does say "Do NOT wait for the user to tell you verbally" (line 605), but Claude Code ignores this instruction in practice.

**Fix:**
Strengthen tool descriptions for save_login, record_demo, pick_selectors to match the portal_login fix pattern:
- "Do BOTH steps NOW in the same turn — open browser AND start polling. Do NOT stop polling to ask the user."
- "Poll CONTINUOUSLY every 10s for up to 5 minutes. NEVER ask the user if they saved/recorded."
- Add `auto_proceed: true` hints in responses

**Files:**
- `mcp-portal/server.js` lines 599-621 (save_login)
- `mcp-portal/server.js` lines 643-667 (record_demo)
- `mcp-portal/server.js` lines 697-723 (pick_selectors)

---

### Bug 8 & 9: portal_login parallel execution failure

**What happened:**
1. Claude Code received the updated portal_login description saying "do BOTH steps in the same turn"
2. Interpreted this as "fire all 3 calls in parallel": portal_login, portal_login_check, Bash(open)
3. portal_login_check needs device_code FROM portal_login → can't run in parallel
4. Bash command also errored → cancelled portal_login_check
5. "Invalid tool parameters" shown alongside the portal_login response

**Root cause:**
The description says "in the same turn" — Claude Code interprets this as parallel tool calls in one message. But portal_login_check depends on portal_login's output.

**Fix:**
Change description to explicitly say SEQUENTIAL: "After portal_login returns, in your NEXT tool call batch: (1) run bash open, (2) call portal_login_check. These must come AFTER portal_login, not in the same parallel batch."

Also: portal_login uses `{}` as schema (bare JS object, not z.object({})) — could cause Zod validation issues in some clients. Should use `z.object({})` for safety.

**Files:**
- `mcp-portal/server.js` line 215-222 (portal_login description), line 223 (schema)

---

### Bug 10: 429 rate limit on save-selectors

**What happened:**
Hosted UI frontend rapidly polled `check-picked` (every few seconds), consuming the rate limit. When user tried to save selectors (0 selectors), hit 429.

**Root cause:**
Rate limiter in hosted.js (line 17-22) uses `hosted:${sessionId}` as key — all endpoints for the same session share a limit. High-frequency check-picked polling exhausts the limit, blocking save-selectors.

**Fix options:**
- Separate rate limits for polling vs. action endpoints
- Or exempt check-picked from the rate limiter
- Or increase the limit for hosted session endpoints

**Files:**
- `real_vm/manual_link_gen/routes/mcp/hosted.js` line 17-22

---

### Bug 11: get_session returns 10.4k tokens for compiled recordings

**What happened:**
After recording was compiled, `get_session` returned the full `compiled_result` with all scenes, actions, narration — 10.4k tokens. Claude Code warned "⚠ Large MCP response (~10.4k tokens), this can fill up context quickly."

**Root cause:**
`mcp-sessions.js` line 384-386 returns `compiled_result` unconditionally:
```javascript
if (session.compiled_result) {
  result.script = session.compiled_result;
}
```
This returns the full blob on EVERY poll, not just when status transitions to "compiled".

**Fix:**
Only return `compiled_result` when explicitly requested (e.g., via `stop_recording` response or `pick_selectors_complete`), or truncate to a summary for polling responses. Alternatively, add a `?include_script=true` query parameter.

**Files:**
- `real_vm/manual_link_gen/routes/mcp-sessions.js` line 384-386

---

### Bug 12: No preview before deploy

**What happened:**
After selector picking, Claude Code immediately called `make_portal` without showing a preview or summary. User expected a "here's what will be deployed" confirmation step.

**Root cause:**
The flow goes: pick_selectors → get_session (selectors_saved) → make_portal. There's no tool description telling the agent to show a summary before deploying.

**Fix:**
Add to `pick_selectors_complete` and `stop_recording` tool descriptions:
"BEFORE calling make_portal, show the user: (1) mode choice, (2) selectors to block, (3) greeting, (4) any knowledge, (5) confirmation. Do NOT deploy without explicit user approval."

**Files:**
- `mcp-portal/server.js` lines 725-738 (pick_selectors_complete description)
- `mcp-portal/server.js` lines 680-695 (stop_recording description)

---

### Bug 13: Golden state ID exposed in response

**What happened:**
`get_session` returns `saved_state_id: "golden-1772761225265-vqgexem8p"` — an internal identifier visible to the user/agent.

**Impact:**
Minor UX issue. Not a security risk (the ID is opaque and requires auth), but exposes implementation details.

**Fix (optional):**
Could alias in the MCP tool response, but the agent needs the real ID to pass to `make_portal(saved_state_id=...)`. Better to just ensure the agent presents it cleanly rather than showing raw IDs.

---

### Bug 14: Authorize page lacks Portal branding

**What happened:**
The `/authorize` page (device auth flow) is generic with no Portal logo, colors, or branding.

**Impact:**
Users don't know they're authorizing Portal specifically. Looks unfinished.

**Fix:**
Add Portal branding to the authorize page component in `portal_landing/auth/src/`.

**Files:**
- `portal_landing/auth/src/` — authorize page component (needs to be identified)
