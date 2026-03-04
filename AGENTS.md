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

When the user says something like "Make me a portal for X":

### Auth check: Does the site need sign-in?

If the URL is likely behind authentication (dashboards, admin panels, settings pages,
anything that isn't the public homepage), call `save_login` directly. The user will
approve or deny via the tool confirmation dialog — don't ask a separate question.

**If save_login is approved:**

1. The response includes a `hosted_url` — **auto-open it** via shell command
2. Tell the user: **"Log in normally, then press Save when done."**
3. Poll `get_session` every 10 seconds until status is `ready`
4. The response includes `saved_state_id` — this carries forward

### How should the demo be created?

Ask: **"Want to record it yourself, or should I generate the demo?"**

1. **Record it myself** — user clicks around in a live browser while we capture actions
2. **Let AI generate it** — AI explores the site and builds a guided tour automatically

---

## Option A: User Records the Demo

The user clicks around in a hosted browser while the system records their actions into structured scenes. Most accurate — the user shows exactly what they want.

**Public site (no saved_state_id):**

1. Call `record_demo` with `url` → response includes `hosted_url`
2. **Auto-open the `hosted_url`** via shell command
3. Tell the user: **"Click through the demo you want to show. Press stop when done."**
4. Poll `get_session` every 10 seconds — when status changes to `compiled`, the recording is done
5. Present the review (see **Reviewing the Draft** below)
6. After user approves, call `make_portal`

**Authenticated site (has saved_state_id):**

1. Call `record_demo` with `url` AND `saved_state_id` — browser opens already logged in
2. **Auto-open the `hosted_url`** via shell command
3. Tell the user: **"You're already signed in. Click through the demo, then press stop."**
4. Same polling + review flow as above

## Option B: AI Auto-Generates the Demo

AI explores the site (via LLM for public URLs, via headless VM for authenticated) and generates scenes automatically.

**Public site — fast LLM path (~10 seconds):**

1. Call `create_script` with `url` and `goals` (e.g. `["Show pricing", "Highlight key features"]`)
2. Tell the user: **"Generating a demo script — about 10 seconds."**
3. Poll `get_script` every 10 seconds until status is `draft`
4. Present the review (see **Reviewing the Draft** below)
5. After user approves, call `make_portal`

**Authenticated site — VM exploration (~60-120 seconds):**

1. Call `create_script` with `url`, `goals`, AND `saved_state_id`
2. Tell the user: **"Starting headless exploration of your authenticated app — this takes 1-2 minutes."**
3. Warn: **"The AI navigates the browser autonomously. It avoids write operations but review carefully."**
4. Poll `get_script` every 15-20 seconds until status is `draft`
5. Present the review (see **Reviewing the Draft** below) — user should check actions carefully
6. After user approves, call `make_portal`

---

## Reviewing the Draft

When scenes are ready (from recording or AI generation), present a **complete review** to the user before creating the portal. This is the most important step — the user confirms everything looks right.

### 1. Mode selection

Ask: **"Should this be a guided demo (watch mode) or a free-browse experience (play mode)?"**

- **Watch mode** — Agent leads the demo following the scenes with narration. The scenes become the script.
- **Play mode** — Viewers explore freely with an AI copilot. No script needed, but use the generated knowledge and selectors.

### 2. Formatted scenes (watch mode)

Show each scene clearly:

```
Scene 1: Homepage Overview
  "Welcome to Acme — let me show you around the dashboard."
  Actions: scroll down, click "Features", wait 2s

Scene 2: Pricing Page
  "Here's the pricing — three tiers starting with a free plan."
  Actions: click "Pricing", scroll down

Scene 3: Key Integration
  "The API integrates in under 5 minutes with any framework."
  Actions: click "Docs", click "Quickstart"
```

Ask: **"Want to edit, reorder, or remove any scenes?"**

### 3. Example Q&A (review-only)

If the script includes `example_qa`, show them so the user can verify the AI will say the right things:

```
Q: "What does Acme do?"
A: "Acme provides real-time analytics for SaaS products." (source: page_content)

Q: "How much does it cost?"
A: "They offer multiple tiers — check the pricing page for current rates." (source: inferred)

Q: "How does this compare to Mixpanel?"
A: "Acme focuses on developer-first workflows with native API access." (source: inferred)
```

Ask: **"Are these answers accurate? Anything the AI should answer differently?"**

### 4. Guardrails and selectors

Show what will be blocked/allowed:

**Blocked selectors** (elements hidden or disabled in the portal):
```
- a[href='/login'] ("Sign in" — auth flow)
- .cookie-banner (cookie consent)
- #delete-account (danger zone)
```

**Allowed URLs** (where viewers can navigate):
```
- acme.com/*
- acme.com/pricing
- acme.com/docs
```

Ask: **"Should anything else be blocked or allowed?"**

### 5. Greeting and knowledge

Show the AI agent's greeting and knowledge base summary. The user can tweak both.

### 6. Final confirmation

After all edits: **"Ready to create the portal? This uses 1 credit."**

---

## Storing Credentials (optional, reusable)

If a user wants to save login credentials for reuse across multiple portals:

1. Call `create_credential` with name, domain, and values
2. The `credential_id` can be passed to `create_script` for automated login during exploration

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
