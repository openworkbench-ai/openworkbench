# shell-auth Specification

## Purpose

Protect all `/platform/` routes behind a single-admin session-cookie auth guard, with a
login/logout endpoint pair and a password bootstrap that never requires a server restart
when the env var is absent.

## Requirements

### Requirement: Password bootstrap on first boot

The system SHALL read the admin password from the `POCKETKNIFE_ADMIN_PASSWORD` environment
variable at startup (bcrypt-hashed and cached in memory). If the variable is absent the
server SHALL generate a random 16-character alphanumeric password, print it once to stdout
as `POCKETKNIFE ADMIN PASSWORD: <password>` (with a surrounding banner), and use it for the
session. The server SHALL NOT refuse to start if the variable is absent.

#### Scenario: Env var present

- **WHEN** `POCKETKNIFE_ADMIN_PASSWORD` is set to a non-empty string
- **THEN** the server starts silently and accepts that password on login

#### Scenario: Env var absent

- **WHEN** `POCKETKNIFE_ADMIN_PASSWORD` is not set
- **THEN** the server prints the generated password to stdout, starts normally, and accepts
  that password for the lifetime of the process

### Requirement: Login endpoint

The system SHALL serve `POST /platform/auth/login` accepting `application/json` with fields
`password` (string). On success it issues a session token as an HttpOnly, SameSite=Strict
cookie named `pk_session` with a 24-hour TTL and responds HTTP 200 `{"ok":true}`. On
failure it responds HTTP 401 `{"error":"invalid password"}`. The endpoint is exempt from
the auth guard.

#### Scenario: Correct password

- **WHEN** a POST to `/platform/auth/login` with the correct password
- **THEN** the response is HTTP 200 and the `Set-Cookie` header contains
  `pk_session=<token>; HttpOnly; SameSite=Strict; Path=/platform`

#### Scenario: Wrong password

- **WHEN** a POST to `/platform/auth/login` with an incorrect password
- **THEN** the response is HTTP 401 and no `Set-Cookie` header is present

#### Scenario: Brute-force delay

- **WHEN** a login attempt fails
- **THEN** the server waits at least 200 ms before responding (constant-time comparison plus
  floor delay)

### Requirement: Logout endpoint

The system SHALL serve `POST /platform/auth/logout`. On request it expires the `pk_session`
cookie and responds HTTP 200 `{"ok":true}`. The endpoint is exempt from the auth guard (so
a logged-out client can still call it).

#### Scenario: Logout clears session

- **WHEN** a POST to `/platform/auth/logout` with a valid session cookie
- **THEN** the session token is invalidated server-side and the response sets `pk_session`
  with `Max-Age=0`

### Requirement: Auth guard on /platform/ routes

The system SHALL verify the `pk_session` cookie on every request to `/platform/` except
`/platform/auth/login` and `/platform/auth/logout`. An absent or invalid token SHALL result
in HTTP 401 `{"error":"unauthorized"}` and no handler logic runs. Valid tokens have their
TTL renewed on each successful request (sliding expiry).

#### Scenario: Authenticated request

- **WHEN** a request to `/platform/registry` carries a valid `pk_session` cookie
- **THEN** the response is the normal handler response

#### Scenario: Missing session

- **WHEN** a request to `/platform/registry` has no `pk_session` cookie
- **THEN** the response is HTTP 401

#### Scenario: Expired session

- **WHEN** a request arrives with a `pk_session` token whose TTL has elapsed
- **THEN** the response is HTTP 401

### Requirement: Unprotected routes remain open

Routes outside `/platform/` — `/apps/`, `/ui/`, `/builds/`, `/validate`, `/deploy`,
`/export/` — SHALL NOT require auth in this phase.

#### Scenario: App API without cookie

- **WHEN** a request to `/apps/my_app/entities/books` is made with no session cookie
- **THEN** the response is the normal handler response (no auth required)
