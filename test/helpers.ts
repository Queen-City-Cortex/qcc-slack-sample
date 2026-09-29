// Synthetic test support. Every ID, token, and canary string here is invented;
// nothing is copied from a recorded Slack response.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import type { CollectOptions, Transport, TransportRequest, TransportResponse } from '../src/types.ts';

export const WORKSPACE_ID = 'TFAKE0001';
export const FAKE_TOKEN = 'xoxp-synthetic-test-token-0000';

/** Replaces global fetch for the file's lifetime and fails if anything calls it. */
export function forbidLiveNetwork(): void {
  const original = globalThis.fetch;
  let attempts = 0;
  before(() => {
    globalThis.fetch = (async () => {
      attempts += 1;
      throw new Error('live network is forbidden in tests');
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = original;
    assert.equal(attempts, 0, 'a test attempted live network access');
  });
}

export interface ScriptedTransport {
  readonly transport: Transport;
  readonly requests: TransportRequest[];
}

/** Returns scripted responses in order; any extra request fails the test. */
export function scripted(...responses: TransportResponse[]): ScriptedTransport {
  const requests: TransportRequest[] = [];
  const queue = [...responses];
  const transport: Transport = async (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return next;
  };
  return { transport, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, body: JSON.stringify(body) };
}

export function page(members: unknown[], nextCursor?: string): TransportResponse {
  return json({
    ok: true,
    members,
    ...(nextCursor === undefined ? {} : { response_metadata: { next_cursor: nextCursor } }),
  });
}

export function member(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, team_id: WORKSPACE_ID, deleted: false, is_bot: false, ...extra };
}

export function options(transport: Transport, extra: Partial<CollectOptions> = {}): CollectOptions {
  return { workspaceId: WORKSPACE_ID, token: FAKE_TOKEN, transport, ...extra };
}
