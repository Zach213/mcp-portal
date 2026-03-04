# Portal MCP — Agent Instructions

You have access to the Portal MCP server, which lets you create interactive browser experiences ("Portals") for any website. A Portal is a sandboxed, shareable browser session — like a live, clickable demo.

## First Interaction

When a user first asks you to do something with Portal:

1. Call `portal_status` to check authentication
2. If not authenticated, call `portal_login` to start sign-in
3. **IMMEDIATELY open the `verification_url`** via shell command (`open "URL"` on macOS, `xdg-open "URL"` on Linux, `start "URL"` on Windows) — do NOT just print it
4. Call `portal_login_check` ONCE with the `device_code` — it auto-polls for up to 2 minutes
5. Once authenticated, proceed to determine their intent

## Decision Tree

When the user says "Make me a portal for X", follow this flow in order:

### Node A: Entry Type Classification

Decide internally — four possibilities:

| Signal | Classification |
|---|---|
| Public marketing page, docs, landing page | **PUBLIC** |
| Dashboard, admin panel, SaaS app, settings, internal tool | **NEEDS AUTH** |
| User mentions local path, localhost, "my app" | **LOCAL FILE** |
| Ambiguous | **NOT SURE → ask** |

**Err on NOT SURE if unclear.** Ask: "Does [site] require you to be logged in?"

**If NEEDS AUTH:**
1. Call `save_login` — user approves/denies via tool confirmation dialog
2. Auto-open the `hosted_url` via shell command
3. Tell user: **"Log in normally, then press Save when done."**
4. Poll `get_session` every 10s until `saved_state_id` is returned
5. Continue to Node B with `saved_state_id`

**If PUBLIC or LOCAL FILE:** Continue to Node B directly.

### Node B: Mode Selection

Ask: **"Play mode (you click around, AI answers questions) or Watch mode (AI leads a guided demo)?"**

If unclear, ask. Then branch:

---

#### Watch Mode

**Watch + Public (no auth):**

Ask: **"Want me to generate the scenes, or record yourself?"**

- **Generate:** Call `create_script` with URL + goals → poll `get_script` (~12s)
- **Record:** Call `record_demo` with URL → auto-open hosted_url → user demos → `stop_recording`

**Watch + Auth (has saved_state_id):**

Default to recording:
1. Call `record_demo` with URL + `saved_state_id` → auto-open hosted_url
2. Tell user: **"Getting recording ready — you're already signed in. Demo the flow, press stop when done."**
3. Poll + compile

If user says "do it async" / "generate it":
1. Call `create_script` with URL + `saved_state_id` + goals → VM exploration (~60-120s)

**Never scrape authenticated sites for selectors in watch mode** — we don't send autonomous agents through their product.

---

#### Play Mode

**Play + Public (no auth):**

Two offers:
1. **Selector blocking:** "Want to block any buttons/elements on the page?"
   - Yes → provide selectors (future: dedicated hosted tool)
   - No → skip
2. **AI context:** "Want us to check out the site to build context for the AI?"
   - Yes → `create_script` to scrape content for knowledge base
   - No → skip

**Play + Auth (has saved_state_id):**

Same offers BUT:
- **Never scrape an authenticated site** — no autonomous browsing inside their product
- Selector blocking = user specifies manually in chat
- Knowledge/context = user provides it, not scraped

---

### Node C: Draft Review

Present the draft:

**Watch mode draft:**
- Scenes with narration text and actions
- Greeting
- `example_qa` if generated — **always show these, never skip**

**Play mode draft:**
- Blocked selectors / disabled elements
- Allowed URLs
- Greeting
- Knowledge context

Ask: **"Here's the draft. Look good?"**

If user wants edits → make them, re-present.

**Ready to deploy:** "This uses 1 credit. Create the portal?"

---

### After Deploy

1. Call `make_portal` → deploy → returns shareable URL
2. Auto-open the portal URL
3. Say: **"Check it out! Once you're happy:"**
   - **Share this link** — send as-is
   - **Create a limited-use link** — for controlled distribution
   - **Embed it** on a specific URL
   - **View session replays** — see what viewers did (`get_portal_sessions`)

### If User Doesn't Like the Deploy

Go back to **Node B** — they can switch modes, re-record, re-generate, or edit.

---

### Key Rules

1. **Never scrape authenticated sites autonomously** — only user-controlled recording or explicit async generation
2. **Err on "not sure"** for auth classification — wrong guess wastes time
3. **Auto-open all hosted URLs** — never make the user copy-paste
4. **Draft review is mandatory** — never skip Node C
5. **Post-deploy is a conversation** — offer embed, limited links, session replays

---

## Building a .ptl Spec

The Portal spec (`.ptl`) is the configuration object. Key fields:

```json
{
  "entry": {
    "url": "https://example.com"
  },
  "experience": {
    "mode": "play",
    "agent": {
      "goal": "Required for watch mode",
      "greeting": "What the agent says first",
      "scenes": [
        {
          "script": "What the agent narrates",
          "actions": [
            { "action": "click", "selector": "a[href='/pricing']" },
            { "action": "scroll_down" },
            { "action": "type", "selector": "#search", "text": "query" },
            { "action": "wait", "ms": 2000 }
          ]
        }
      ]
    }
  },
  "guardrails": {
    "allowed_urls": ["https://example.com/*"],
    "disabled_elements": [".cookie-banner"]
  }
}
```

**Modes:**
- `play` — User explores freely. Agent answers questions. No script needed.
- `watch` — Agent leads the demo, following scenes with scripted actions. **Requires** `goal` and `scenes`.

## Tool Reference

| Tool | Auth Required | Description |
|---|---|---|
| **Auth** | | |
| `portal_login` | No | Start device auth sign-in |
| `portal_login_check` | No | Poll for sign-in approval |
| `portal_logout` | No | Sign out |
| `portal_status` | No | Check auth status |
| **Portal CRUD** | | |
| `make_portal` | Yes | Create a portal (validates internally — skip `validate_ptl`) |
| `get_portal` | Yes | Poll portal provisioning status |
| `list_portals` | Yes | List recent portals |
| `get_portal_sessions` | Yes | Get session replays: conversation logs + signed recording URLs (10 min) |
| **Login Capture** | | |
| `save_login` | Yes | Start login capture session → `hosted_url` |
| `save_login_complete` | Yes | Save captured login → `saved_state_id` |
| **Recording** | | |
| `record_demo` | Yes | Start recording session → `hosted_url` |
| `start_recording` | Yes | Begin capturing actions |
| `stop_recording` | Yes | Stop + compile into scenes |
| `get_session` | Yes | Poll session status |
| **AI Script Generation** | | |
| `create_script` | Yes | Auto-generate demo via LLM/headless exploration |
| `get_script` | Yes | Poll script generation status |
| **Credential Vault** | | |
| `create_credential` | Yes | Store encrypted login credentials |
| `list_credentials` | Yes | List vault entries (metadata only) |
| `delete_credential` | Yes | Delete a credential |
| **Billing** | | |
| `buy_credits` | Yes | Create Stripe Checkout session for credit purchase |
| **Spec Utilities** | | |
| `normalize_ptl` | Yes | Normalize a spec to canonical form |
| `validate_ptl` | Yes | Validate a spec (not needed before `make_portal`) |

## Important Notes

- `make_portal` validates internally — do NOT call `validate_ptl` separately
- Portal URLs expire after 10 minutes of viewer inactivity
- `create_script` is async — poll `get_script` until status is `draft`
- `save_login` and `record_demo` return a `hosted_url` the user must open in their browser
- Never expose credential passwords — the API only returns metadata
- When `make_portal` returns `provisioning`, poll `get_portal` every 15s (up to 5 min)
