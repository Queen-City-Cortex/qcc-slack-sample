import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFetchTransport } from '../src/index.ts';
import { FAKE_TOKEN, forbidLiveNetwork } from './helpers.ts';

forbidLiveNetwork();

describe('createFetchTransport', () => {
  it('uses the injected fetch, refuses redirects, and lower-cases response headers', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true,"members":[]}', { status: 429, headers: { 'Retry-After': '7' } });
    }) as typeof fetch;

    const transport = createFetchTransport(fakeFetch);
    const response = await transport({
      method: 'GET',
      url: 'https://slack.com/api/users.list?limit=100',
      headers: { authorization: `Bearer ${FAKE_TOKEN}` },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://slack.com/api/users.list?limit=100');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(calls[0]?.init?.redirect, 'error');
    assert.deepEqual(calls[0]?.init?.headers, { authorization: `Bearer ${FAKE_TOKEN}` });
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '7');
    assert.equal(response.body, '{"ok":true,"members":[]}');
  });

  it('refuses any URL other than the users.list endpoint', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('');
    }) as typeof fetch;
    const transport = createFetchTransport(fakeFetch);
    await assert.rejects(transport({ method: 'GET', url: 'https://example.invalid/api/users.list', headers: {} }));
    assert.equal(called, false);
  });
});
