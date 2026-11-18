/** Preserve application errors; identify non-JSON upload rejections from proxies. */
export async function apiError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  if (typeof body?.error === "string" && body.error.trim()) return new Error(body.error);
  if (response.status === 413) {
    return new Error("A web server rejected this upload as too large (HTTP 413). Ask the administrator to check the server's upload limit.");
  }
  return new Error(fallback);
}
