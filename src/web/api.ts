/** Every server refusal is one sentence in `error`; surface it as-is. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message);
  }
}

/** The sentence for a request that never got an answer. Access sign-in redirects are blocked by the browser, so an expired session looks the same as no network; say both. */
export const UNREACHABLE = 'Could not reach the server. If you have been away, your Cloudflare Access sign-in may have expired: reload the page to sign in again. This app keeps no data locally, so nothing works offline.';

/** The sentence for an answer that is not from this app (a login page, a gateway error) or that carries no reason. */
export const noReason = (status: number): string => status === 401 || status === 403
  ? 'The server refused the request; your Cloudflare Access sign-in may have expired. Reload the page to sign in again.'
  : `The server answered ${status} without saying why; try again in a moment.`;

/** An answer's reason as one sentence; an empty list is no reason (an empty `errors` once rendered a blank red box). */
export const reasonOf = (json: { error?: string; errors?: string[] }, status: number): string =>
  json.error || (json.errors?.length ? json.errors.join(' ') : noReason(status));

/**
 * POST for the import forms, which show a refusal themselves. Answers with the JSON body, or `problem`: one sentence
 * saying whether the server could not be reached or answered something that is not from this app.
 */
export async function postImport<T>(path: string, body: unknown): Promise<{ status: number; json: T } | { problem: string }> {
  let res: Response;
  try { res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { return { problem: UNREACHABLE }; }
  try { return { status: res.status, json: (await res.json()) as T }; }
  catch { return { problem: noReason(res.status) }; }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[]; detail?: unknown };
  if (!res.ok) throw new ApiError(reasonOf(json, res.status), res.status, json.detail);
  return json as T;
}

/** One id per user action, reused if the request is retried, so a retry cannot double-apply. */
export const newId = (): string => crypto.randomUUID().replace(/-/g, '');
