import type { Transport } from './types.ts';

const ALLOWED_ORIGIN = 'https://slack.com';
const ALLOWED_PATH = '/api/users.list';

/**
 * Wraps `fetch` as a Transport. Only the users.list endpoint is reachable and
 * redirects are refused so the Authorization header cannot be forwarded.
 */
export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== ALLOWED_ORIGIN || url.pathname !== ALLOWED_PATH) {
      throw new Error('transport refused a non-users.list URL');
    }
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      redirect: 'error',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}
