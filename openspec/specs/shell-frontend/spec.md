# shell-frontend Specification

## Purpose

Serve the compiled shell SPA at the root path and implement the six launcher screens
(Login, Home, New App Sheet, Plan Review, Building State, App Inside View) as a polished
React/Vite app against the platform API.

## Requirements

### Requirement: Shell served at root

The Go binary SHALL serve the compiled shell SPA from `shell/dist/` at the root path `/`.
All paths that do not match a known Go route SHALL fall through to `shell/dist/index.html`
(SPA fallback). In development the shell is served by Vite on `:3001`; the binary is given
`-cors` to allow the cross-origin requests.

#### Scenario: Production root request

- **WHEN** a GET to `/` is made in production (no `-cors` flag)
- **THEN** the response is the shell's `index.html` with `Content-Type: text/html`

#### Scenario: SPA deep link

- **WHEN** a GET to `/home` or `/app/reading` is made
- **THEN** the response is the shell's `index.html` (client-side router takes over)

### Requirement: Screen 01 — Login

The shell SHALL render a login screen at `/login`. It MUST display the POCKETKNIFE
wordmark, tagline ("Your little apps, in one pocket."), an email/password form (password
only; email field is decorative/UX-only in single-user mode), and a "Sign in →" button. On
success the shell navigates to `/home`. If the server returns 401 an inline error is shown
without page reload. The screen MUST render correctly in both light and dark mode.

#### Scenario: Successful login

- **WHEN** the user submits the correct password
- **THEN** the shell calls `POST /platform/auth/login`, receives 200, and navigates to
  `/home`

#### Scenario: Wrong password

- **WHEN** the user submits an incorrect password
- **THEN** an inline error "Incorrect password" is shown; the password field is cleared

#### Scenario: Already logged in

- **WHEN** a user navigates to `/login` with a valid session cookie
- **THEN** the shell immediately redirects to `/home`

### Requirement: Screen 02 — Home Launcher

The shell SHALL render the home launcher at `/home`. It MUST display: a greeting line
("Tuesday · evening", derived from current time), "Your pocketknife" heading with a user
emoji avatar, three tab filters ("All apps", "Recent", "Pinned"), a "Jump Back In" card
showing the last-opened app (stored in localStorage, omitted if none), a "Your apps — N
EDIT" header, an emoji tile grid of all registered apps (emoji + display name per tile,
background color from metadata), a "+ New" tile at the end of the grid, and a bottom
navigation bar with four icons (Home, Search, History, Menu). The tile count N reflects the
live registry.

#### Scenario: Grid renders from registry

- **WHEN** the shell loads `/home` with a valid session
- **THEN** `GET /platform/registry` is called and each returned app renders as an emoji tile
  in `gridOrder` order

#### Scenario: Jump Back In present

- **WHEN** the user has previously opened an app (recorded in localStorage)
- **THEN** a "Jump Back In" card appears above the grid showing the app's emoji and display
  name

#### Scenario: Jump Back In absent

- **WHEN** no app has been opened in this browser
- **THEN** no "Jump Back In" card is shown

#### Scenario: Building tile

- **WHEN** an app's `buildState` is `building` or `activating` or `queued`
- **THEN** its tile renders with a circular progress ring overlay and the label "Building…"
  instead of the display name

#### Scenario: Failed build tile

- **WHEN** an app's `buildState` is `failed`
- **THEN** its tile renders with an error indicator (red border or "!" badge)

#### Scenario: Dark mode

- **WHEN** the OS or browser prefers dark color scheme
- **THEN** the launcher renders in the dark palette from `docs/design` screen 02-dark

### Requirement: Screen 03 — New App Sheet

The shell SHALL render a bottom-sheet modal when the user taps "+ New". It MUST display: a
close (✕) button, a title "New app", two tabs ("Describe it" / "Paste code"), a free-text
area with placeholder text, a character counter, a hint "BE SPECIFIC — REFINE NEXT", an
"Or start from an idea" section with three suggestion pills (shuffled from a curated list
on each open), and a "Create app →" button that is enabled only when the text area is
non-empty.

#### Scenario: Open sheet

- **WHEN** the user taps "+ New"
- **THEN** the bottom sheet animates up and the "Describe it" tab is active

#### Scenario: Suggestion pill

- **WHEN** the user taps a suggestion pill
- **THEN** the pill's text is placed in the text area and the character counter updates

#### Scenario: Create app

- **WHEN** the user taps "Create app →" with non-empty text
- **THEN** the sheet closes and the shell navigates to `/plan/{sessionId}` where a new
  planning session has been started

#### Scenario: Paste code tab

- **WHEN** the user taps "Paste code"
- **THEN** the text area hint changes to "Paste your frontend code here" and the same Create
  button triggers a paste-mode planning session

### Requirement: Screen 04 — Plan Review

The shell SHALL render a plan-review conversation at `/plan/{sessionId}`. It MUST display:
a back button ("‹"), a step indicator ("STEP 2 OF 2 · REVIEW"), the app's proposed emoji
and display name, a "What I'll build" checklist derived from the latest plan state, a chat
transcript of the planning conversation (agent turns and user turns), a "Looks good — build
it →" CTA button (enabled when the plan is in a ready-to-build state), a "Request a
change…" text input at the bottom, and a send button. New agent turns are appended as they
arrive via the SSE stream.

#### Scenario: SSE turn received

- **WHEN** the agent emits a plan turn event on the SSE stream
- **THEN** the new agent message appears in the chat transcript and the "What I'll build"
  checklist is updated

#### Scenario: User sends refinement

- **WHEN** the user types in the input and taps send
- **THEN** the message is posted to `POST /platform/plan/{sessionId}/message`, the user's
  turn is appended to the transcript, and the input is cleared

#### Scenario: Ready to build

- **WHEN** the SSE stream emits a `ready` event
- **THEN** the "Looks good — build it →" button becomes active

#### Scenario: Build approved

- **WHEN** the user taps "Looks good — build it →"
- **THEN** the shell posts the approval, navigates to `/home`, and the new app's tile
  appears in `building` state

#### Scenario: SSE disconnected

- **WHEN** the SSE connection drops
- **THEN** the shell shows a "Reconnecting…" indicator and attempts reconnection with
  exponential backoff

### Requirement: Screen 05 — Building State in Launcher

When the home launcher has one or more apps in a building state, the shell SHALL display a
"Building N app…" banner above the grid. The building tile SHALL show: a circular progress
ring, the label "COMPILING", the app's display name, a percentage value (derived from build
stage — queued: 0%, building: 10–80%, activating: 90%, ready: 100%), and a stage
description line (e.g. "setting up books & streak…"). Build state is polled from
`GET /platform/registry` every 3 seconds while any app is in a non-terminal state.

#### Scenario: Build progress polling

- **WHEN** an app is in `building` state and the home screen is mounted
- **THEN** the shell polls `/platform/registry` every 3 seconds

#### Scenario: Build completes

- **WHEN** an app's `buildState` transitions to `ready`
- **THEN** the progress ring is removed, the tile renders normally, and the banner
  disappears if no other builds are active

#### Scenario: Build fails

- **WHEN** an app's `buildState` transitions to `failed`
- **THEN** the tile shows an error state and a toast notification "Build failed for
  <app name>"

### Requirement: Screen 06 — App Inside View

The shell SHALL render an in-app view at `/app/{appId}`. It MUST display: a back button
("‹") that navigates to `/home`, the app's emoji and display name in a header bar, an
overflow menu ("⋯") with options (Rename, Change emoji/color, Delete app), an `<iframe>`
pointing at `/ui/{appId}/` filling the remaining viewport, and an "Ask pocketknife to
change this app…" prompt bar at the bottom. The iframe SHALL have
`sandbox="allow-scripts allow-same-origin allow-forms"`. Opening the app SHALL record the
`appId` in localStorage as the last-opened app.

#### Scenario: App loads in iframe

- **WHEN** the user navigates to `/app/reading_tracker`
- **THEN** the iframe src is `/ui/reading_tracker/` and the app's frontend is displayed

#### Scenario: Back button

- **WHEN** the user taps "‹"
- **THEN** the shell navigates to `/home`

#### Scenario: Last-opened recorded

- **WHEN** the user opens any app
- **THEN** `localStorage.setItem('pk_last_opened', appId)` is called so "Jump Back In"
  shows it next time

#### Scenario: Inline change request

- **WHEN** the user types in the "Ask pocketknife to change this app…" bar and taps send
- **THEN** a new planning session is started in update mode (`--app {appId}`) and the shell
  navigates to `/plan/{sessionId}`

### Requirement: Visual design fidelity

The shell MUST use Space Grotesk (self-hosted subset in `shell/public/fonts/`) as the
primary typeface, with a sans-serif system stack as fallback. Colors, spacing, and component
shapes SHALL follow the `docs/design` reference: editorial flat style, squircle app tiles,
iOS-inspired bottom-sheet animations, and the specific light and dark palettes shown. The
shell MUST NOT use external CDN links for fonts or critical assets.

#### Scenario: Font loads offline

- **WHEN** the server has no outbound internet access
- **THEN** Space Grotesk loads from the local font file and text renders correctly

#### Scenario: System dark mode

- **WHEN** `prefers-color-scheme: dark` is active
- **THEN** background, surface, and text colors match the dark-palette screens in
  `docs/design`
