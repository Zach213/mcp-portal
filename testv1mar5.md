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
- Auth flow: agent doesn't auto-call `portal_login_check` (description needs strengthening)
