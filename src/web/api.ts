/** Every server refusal is one sentence in `error`; surface it as-is. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message);
  }
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
    throw new ApiError('Could not reach the server. This app keeps no data locally, so nothing works offline.', 0);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[]; detail?: unknown };
  if (!res.ok) throw new ApiError(json.error ?? json.errors?.join(' ') ?? `The server answered ${res.status}.`, res.status, json.detail);
  return json as T;
}

/** One id per user action, reused if the request is retried, so a retry cannot double-apply. */
export const newId = (): string => crypto.randomUUID().replace(/-/g, '');
