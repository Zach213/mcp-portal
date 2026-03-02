# Portal MCP — Agent Instructions

You have access to the Portal MCP server, which lets you create interactive browser experiences ("Portals") for any website. A Portal is a sandboxed, shareable browser session — like a live, clickable demo.

## First Interaction

When a user first asks you to do something with Portal:

1. Call `portal_status` to check authentication
2. If not authenticated, call `portal_login` to start sign-in, then tell the user to open the `verification_url`
3. Once authenticated, ask: **"What would you like to create a Portal for?"**

## Understanding the User's Intent

When the user describes what they want, determine which path to take:

### Path A: Public URL (no login required)
**Trigger:** User mentions a public website (docs, landing page, marketing site)
**Example:** "Make me a portal for stripe.com" or "Create a demo of our landing page"

**Flow:**
1. Build a `.ptl` spec with `mode: "play"` (user explores freely)
2. Call `validate_ptl` to check the spec
3. Call `make_portal` with `dry_run: true` first
4. Confirm with user: "This will use 1 credit. Ready?"
5. Call `make_portal` without dry_run
6. Give them the shareable URL

### Path B: Requires Sign-In
**Trigger:** User mentions a site that needs authentication (dashboard, admin panel, SaaS app)
**Example:** "Make a portal for our Stripe dashboard" or "I need to show our app's admin panel"

**Flow:**
1. Call `save_login` with the URL — this returns a `hosted_url`
2. Tell the user: "Open this link and log in normally. Tell me when you're done."
3. When user confirms, call `save_login_complete` with the `session_id`
4. Use the returned `saved_state_id` to create the portal (the portal will start already logged in)

### Path C: Auto-Generate a Demo Script (fast, public URLs)
**Trigger:** User wants an agent-led walkthrough of a public site
**Example:** "Generate a demo that shows off Linear's features" or "Create a guided tour of pricing"

**Flow:**
1. Call `create_script` with the URL and goals (no `saved_state_id`)
2. Tell the user: "Generating a demo script — this takes about 10 seconds."
3. Poll `get_script` every 5 seconds until status is `draft`
4. Show the user the generated scenes (name, narration, actions)
5. Ask: "Want to edit any scenes before creating the portal?"
6. Build a watch-mode `.ptl` spec using the approved scenes
7. Create the portal with `make_portal`

### Path D: Auto-Generate from Saved State (headless exploration)
**Trigger:** User has a saved login and wants an automated demo of an authenticated site
**Example:** "Generate a demo of our dashboard" (after save_login)

**Flow:**
1. Call `create_script` with URL, goals, AND `saved_state_id`
2. Tell the user: "Starting headless exploration — this is experimental and takes 1-2 minutes."
3. Warn: "The AI will navigate the browser autonomously. It avoids write operations but may click wrong things."
4. Poll `get_script` every 15-20 seconds until status is `draft`
5. Present scenes for review. User should check actions carefully.

### Path E: Manual Recording (user clicks around)
**Trigger:** User wants maximum control over the demo content
**Example:** "I want to record a demo myself" or "Let me show you what to demo"

**Flow:**
1. Call `record_demo` with the URL (and optional `saved_state_id` for pre-auth)
2. Tell the user: "Open this link to start recording. Click through the demo you want."
3. User opens the hosted browser, clicks around
4. When user says they're done, call `stop_recording`
5. Present compiled scenes for review, then create portal

### Path F: Store Credentials for Automated Login
**Trigger:** User wants to save login credentials for reuse across portals
**Example:** "Save my GitHub credentials" or "Store login for our staging environment"

**Flow:**
1. Call `create_credential` with name, domain, and values
2. The credential_id can be passed to `create_script` or used with `save_login` for pre-authenticated sessions

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
- `play` — User explores freely. Agent is available to answer questions.
- `watch` — Agent leads the demo, following scenes with scripted actions. **Requires** `goal` and `scenes`.

## Tool Reference

| Tool | Auth Required | Description |
|---|---|---|
| `portal_login` | No | Start device auth sign-in |
| `portal_login_check` | No | Poll for sign-in approval |
| `portal_logout` | No | Sign out |
| `portal_status` | No | Check auth status |
| `normalize_ptl` | Yes | Normalize a spec to canonical form |
| `validate_ptl` | Yes | Validate a spec (catches errors before create) |
| `make_portal` | Yes | Create a portal (use `dry_run: true` first) |
| `get_portal` | Yes | Check portal status |
| `save_login` | Yes | Start login capture session |
| `save_login_complete` | Yes | Save captured login state |
| `record_demo` | Yes | Start demo recording session |
| `start_recording` | Yes | Begin recording |
| `stop_recording` | Yes | Stop and compile recording |
| `get_session` | Yes | Poll session status |
| `create_script` | Yes | Auto-generate demo via headless exploration |
| `get_script` | Yes | Poll script generation status |
| `create_credential` | Yes | Store encrypted credentials |
| `list_credentials` | Yes | List credential vault entries |
| `delete_credential` | Yes | Delete a credential |

## Important Notes

- Always `validate_ptl` before `make_portal`
- Always `dry_run: true` before real creation (costs credits)
- Portal URLs expire after 10 minutes of viewer inactivity
- `create_script` is async — poll `get_script` until ready
- `save_login` and `record_demo` require the user to interact in a browser
- Never expose credential passwords — the API only returns metadata
