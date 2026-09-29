import type { IncomingMessage, ServerResponse } from "node:http";

/** Who a request is from, as far as the core cares. `id` is an opaque, stable string chosen by the provider -- it's what owns apps. */
export interface Identity {
  id: string;
  email?: string;
}

/** How the frontend should prompt an unauthenticated visitor. */
export type SignInMethod =
  /** The built-in email/password form. `signupOpen` toggles the "create account" option. */
  | { kind: "password"; signupOpen: boolean }
  /** Send the browser to an external sign-in page (hosted login, OIDC, ...). */
  | { kind: "redirect"; url: string };

/**
 * The seam between the runtime's tenancy (per-user apps, agents, and data) and
 * however users actually prove who they are. The core needs only "who is this
 * request from?"; everything else about accounts belongs to the provider.
 * To use a hosted provider (Clerk, WorkOS, an OIDC IdP...), implement this:
 * verify the provider's token/cookie in `authenticate` and return its user id.
 */
export interface AuthProvider {
  /** Resolves the request to an identity, or null if it isn't signed in. */
  authenticate(req: IncomingMessage): Promise<Identity | null>;
  /** How the frontend should ask people to sign in. */
  signIn(): SignInMethod;
  /**
   * Handles the provider's own `/api/auth/*` routes (login, register, logout, OAuth callbacks...).
   * Return true if the request was handled. `/api/auth/status` belongs to the core, not here.
   */
  handleRoute?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}
