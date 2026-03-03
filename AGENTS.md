# Portal MCP — Agent Instructions

You have access to the Portal MCP server, which lets you create interactive browser experiences ("Portals") for any website. A Portal is a sandboxed, shareable browser session — like a live, clickable demo.

## First Interaction

When a user first asks you to do something with Portal:

1. Call `portal_status` to check authentication
2. If not authenticated, call `portal_login` to start sign-in, then open the `verification_url` in the user's browser
3. Poll `portal_login_check` with the `device_code` every 5 seconds until approved
4. Once authenticated, proceed to determine their intent

## Decision Tree

When the user says something like "Make me a portal for X", answer **two questions** in order:

### Question 1: Does the site need sign-in?

| Signal | Answer |
|---|---|
| Public site (landing page, docs, marketing) | **No** — skip straight to Question 2 |
| Dashboard, admin panel, SaaS app, anything behind auth | **Yes** — save their login first |

**If YES — save login first:**

1. Call `save_login` with the URL → returns `hosted_url` + `session_id`
2. Tell the user: **"Open this link and log in normally. Press the save button in the hosted UI when done."**
3. Poll `get_session` every 5 seconds — when status changes to `ready`, login is saved
4. The response includes `saved_state_id` — this carries forward to Question 2
5. The hosted UI automatically prompts the user: "Keep this Portal logged in?" with a credential form (username, password, optional TOTP). This is handled entirely in the browser — do NOT ask about credentials yourself.
6. Now proceed to Question 2

### Question 2: How should the demo content be created?

Two options. If the user doesn't specify, ask:

> **"Would you like to record the demo yourself, or let AI generate it?"**
> 1. **Record it myself** — you click around in a live browser while we capture your actions
> 2. **Let AI generate it** — AI explores the site and builds a guided tour automatically

---

## Option A: User Records the Demo

The user clicks around in a hosted browser while the system records their actions into structured scenes. Most accurate — the user shows exactly what they want.

**Public site (no saved_state_id):**

1. Call `record_demo` with `url`
2. Tell the user: **"Open this link to start recording. Click through the demo you want to show. Press the stop button in the hosted UI when done."**
3. Poll `get_session` every 5 seconds — when status changes to `compiled`, the recording is done
4. Present the review (see **Reviewing the Draft** below)
5. After user approves, call `make_portal`

**Authenticated site (has saved_state_id from Question 1):**

1. Call `record_demo` with `url` AND `saved_state_id` — the hosted browser opens **already logged in**
2. Tell the user: **"Open this link — you're already signed in. Click through the demo, then press stop when done."**
3. Same steps 3-5 as above

## Option B: AI Auto-Generates the Demo

AI explores the site (via LLM for public URLs, via headless VM for authenticated) and generates scenes automatically.

**Public site — fast LLM path (~10 seconds):**

1. Call `create_script` with `url` and `goals` (e.g. `["Show pricing", "Highlight key features"]`)
2. Tell the user: **"Generating a demo script — about 10 seconds."**
3. Poll `get_script` every 5 seconds until status is `draft`
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
