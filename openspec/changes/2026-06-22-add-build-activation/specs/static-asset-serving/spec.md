# static-asset-serving Specification

## Purpose

Serve an app's currently-active, pre-built frontend bundle directly from the trusted core,
so a production deployment is one static Go binary answering both the API and the UI from a
single origin, while local development can still run the frontend on a separate origin via
opt-in CORS.

## Requirements

### Requirement: Per-app static frontend serving from the trusted core

The system SHALL serve an app's currently-active frontend bundle at `GET /ui/{app}/{path...}`,
resolving the app's current AssetDir and entry file from the registry on every request rather
than caching it at server start. A request for a path with no real file under AssetDir SHALL
fall back to the manifest's declared entry file (or `index.html` if none is declared), so
client-side routing in a single-page app works without the trusted core knowing any of its
routes.

#### Scenario: Known file is served as-is

- **WHEN** a request path matches a real file under the app's AssetDir
- **THEN** that file's contents are served

#### Scenario: Unknown path falls back to the entry file

- **WHEN** a request path under an activated app does not match a real file
- **THEN** the manifest's declared entry file is served

#### Scenario: An app with no active build is not found

- **WHEN** a registered app has never been activated (its AssetDir is empty) or the app id is
  unknown
- **THEN** the request is answered 404

#### Scenario: A cutover is visible without restarting the asset server

- **WHEN** an app's AssetDir changes due to a new activation, mid-process, with no restart
- **THEN** the very next request for that app is served from the new AssetDir

#### Scenario: Path traversal cannot escape the app's AssetDir

- **WHEN** a request path attempts to escape the app's AssetDir (e.g. via `..` segments)
- **THEN** the resolved file path is cleaned and rooted under AssetDir and can never resolve
  outside it

### Requirement: CORS is opt-in and global

The system SHALL provide a CORS middleware that, when disabled, is a transparent passthrough
adding no headers. When enabled, it SHALL set permissive CORS headers on every response and
SHALL short-circuit an OPTIONS preflight request with a 204 without invoking the wrapped
handler.

#### Scenario: Disabled CORS is a no-op

- **WHEN** CORS is disabled
- **THEN** responses carry no Access-Control-Allow-Origin header and every request still
  reaches the wrapped handler

#### Scenario: Enabled CORS answers a preflight directly

- **WHEN** CORS is enabled and an OPTIONS request arrives
- **THEN** the middleware responds 204 with CORS headers set and does not call the wrapped
  handler
