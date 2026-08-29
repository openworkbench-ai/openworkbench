# model-broker Specification

## Purpose

Be the only path a sandboxed function ever has to a model provider, so the provider token the
host process holds never has a code path back out to a function's prompt, a function's
observable output, or the browser — regardless of what a function's prompt asks for or what a
compromised or malicious provider response contains.

## Requirements

### Requirement: Calling the broker delegates to a configured provider and returns text

The system SHALL provide a narrow, prompt-in-text-out call surface: given a prompt, it SHALL
invoke the configured provider and return its text response, with no other parameters or
provider details exposed to the caller.

#### Scenario: A configured broker delegates to its provider and returns its response

- **WHEN** a model call is made against a broker with a configured provider
- **THEN** the call delegates to that provider and returns its text response unchanged

### Requirement: An unconfigured broker fails closed, indistinguishably from a denial

The system SHALL return a fixed "not configured" error whenever a broker has no provider
configured, including when the broker reference itself is absent. This SHALL behave
identically whether the host process was never given a provider token or the broker value is
nil.

#### Scenario: A broker with no configured provider returns a fixed error

- **WHEN** a model call is made against a broker that has no provider configured
- **THEN** the call returns the not-configured error and makes no provider request

#### Scenario: An absent broker reference behaves the same as an unconfigured one

- **WHEN** a model call is attempted with no broker reference at all
- **THEN** the call returns the same not-configured error as a broker with no provider
  configured

### Requirement: The provider token is never reachable from any function-observable value

The system SHALL hold a real provider's credential in a representation with no accessor,
serialization path, or string representation that could place it into any value a function,
its response, or an external observer of that response could read.

#### Scenario: Serializing the broker or its configured caller never includes the token

- **WHEN** the broker or its configured provider caller is serialized through this codebase's
  standard serialization path
- **THEN** the resulting representation does not contain the token

#### Scenario: A model-capable function's output never contains the provider token

- **WHEN** a function that has declared model access makes a call, including with an
  adversarial prompt designed to try to surface configuration details
- **THEN** that function's observable output never contains the token used to reach the
  provider

### Requirement: The provider call sends the token as a bearer credential and decodes a text response

The system SHALL, for an HTTP-backed provider, send the prompt as a JSON request body with the
token as a bearer authorization header, and SHALL decode a successful JSON response's text
field as the result. A non-success HTTP status SHALL be treated as an error.

#### Scenario: A successful provider call carries the bearer token and the prompt

- **WHEN** an HTTP-backed provider call is made
- **THEN** the request carries the configured token as a bearer credential and the configured
  prompt in its body, and the response's text field is returned as the result

#### Scenario: A non-200 provider response is an error

- **WHEN** the provider responds with a non-200 status
- **THEN** the call returns an error rather than a partial or empty success
