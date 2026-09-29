import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectUsers } from '../src/index.ts';
import type { CollectResult, CompleteResult, IncompleteResult } from '../src/index.ts';
import {
  FAKE_TOKEN,
  WORKSPACE_ID,
  forbidLiveNetwork,
  json,
  member,
  options,
  page,
  scripted,
} from './helpers.ts';

forbidLiveNetwork();

function expectComplete(result: CollectResult): CompleteResult {
  assert.equal(result.status, 'complete', `expected complete, got ${JSON.stringify(result)}`);
  return result as CompleteResult;
}

function expectIncomplete(result: CollectResult, code: string): IncompleteResult {
  assert.equal(result.status, 'incomplete');
  const incomplete = result as IncompleteResult;
  assert.equal(incomplete.error.code, code);
  assert.equal(incomplete.workspaceId, WORKSPACE_ID);
  assert.ok(!('observations' in incomplete), 'incomplete results must not carry partial observations');
  return incomplete;
}

describe('request shape', () => {
  it('sends GET users.list with limit=100 and bearer auth, never the token in the URL', async () => {
    const { transport, requests } = scripted(page([member('UFAKE0001')], 'cursor-a'), page([]));
    await collectUsers(options(transport));

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.method, 'GET');
    assert.equal(requests[0]?.url, 'https://slack.com/api/users.list?limit=100');
    assert.equal(requests[0]?.headers['authorization'], `Bearer ${FAKE_TOKEN}`);
    assert.equal(requests[1]?.url, 'https://slack.com/api/users.list?limit=100&cursor=cursor-a');
    for (const request of requests) assert.ok(!request.url.includes(FAKE_TOKEN));
  });
});

describe('pagination', () => {
  it('returns complete with the caller workspace ID for an empty member list', async () => {
    const { transport } = scripted(page([]));
    const result = expectComplete(await collectUsers(options(transport)));
    assert.equal(result.workspaceId, WORKSPACE_ID);
    assert.equal(result.source, 'slack_users_list');
    assert.deepEqual(result.observations, []);
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.twoFactorFieldVisibility, 'not_assessed');
  });

  it('treats an empty next_cursor as the end of pagination', async () => {
    const { transport, requests } = scripted(page([member('UFAKE0001')], ''));
    expectComplete(await collectUsers(options(transport)));
    assert.equal(requests.length, 1);
  });

  for (const invalidMetadata of [
    { response_metadata: null },
    { response_metadata: { next_cursor: null } },
  ]) {
    it(`does not call a null pagination value complete: ${JSON.stringify(invalidMetadata)}`, async () => {
      const { transport, requests } = scripted(json({ ok: true, members: [member('UFAKE0001')], ...invalidMetadata }));
      const result = expectIncomplete(await collectUsers(options(transport)), 'invalid_body');
      assert.equal(requests.length, 1);
      assert.ok(!('observations' in result));
    });
  }

  it('follows next_cursor after a short first page', async () => {
    const { transport, requests } = scripted(
      page([member('UFAKE0001')], 'cursor-a'),
      page([member('UFAKE0002'), member('UFAKE0003')]),
    );
    const result = expectComplete(await collectUsers(options(transport)));
    assert.equal(requests.length, 2);
    assert.equal(result.pagesFetched, 2);
    assert.deepEqual(
      result.observations.map((o) => o.userId),
      ['UFAKE0001', 'UFAKE0002', 'UFAKE0003'],
    );
  });

  it('stops as incomplete when a cursor repeats', async () => {
    const { transport, requests } = scripted(
      page([member('UFAKE0001')], 'cursor-a'),
      page([member('UFAKE0002')], 'cursor-b'),
      page([member('UFAKE0003')], 'cursor-a'),
    );
    const result = expectIncomplete(await collectUsers(options(transport)), 'repeated_cursor');
    assert.equal(requests.length, 3);
    assert.equal(result.pagesFetched, 3);
  });

  it('stops as incomplete at the page cap instead of looping', async () => {
    const { transport, requests } = scripted(
      page([member('UFAKE0001')], 'cursor-a'),
      page([member('UFAKE0002')], 'cursor-b'),
      page([member('UFAKE0003')], 'cursor-c'),
    );
    const result = expectIncomplete(await collectUsers(options(transport, { maxPages: 2 })), 'page_cap_exceeded');
    assert.equal(requests.length, 2);
    assert.equal(result.pagesFetched, 2);
  });
});

describe('2FA observations', () => {
  it('maps true/false/missing/null has_2fa explicitly', async () => {
    const { transport } = scripted(
      page([
        member('UFAKE0001', { has_2fa: true }),
        member('UFAKE0002', { has_2fa: false }),
        member('UFAKE0003'),
        member('UFAKE0004', { has_2fa: null }),
      ]),
    );
    const result = expectComplete(await collectUsers(options(transport)));
    assert.deepEqual(
      result.observations.map((o) => [o.userId, o.slackNativeTwoFactor]),
      [
        ['UFAKE0001', 'enabled'],
        ['UFAKE0002', 'disabled'],
        ['UFAKE0003', 'unknown'],
        ['UFAKE0004', 'unknown'],
      ],
    );
    assert.equal(result.twoFactorFieldVisibility, 'observed');
  });

  it('fails closed if a later page has a non-boolean has_2fa value', async () => {
    const { transport } = scripted(
      page([member('UFAKE0001', { has_2fa: true })], 'cursor-a'),
      page([member('UFAKE0002', { has_2fa: 'true' })]),
    );
    const result = expectIncomplete(await collectUsers(options(transport)), 'invalid_body');
    assert.equal(result.pagesFetched, 1);
    assert.ok(!('observations' in result));
  });

  it('reports visibility_unverified when has_2fa is absent on every member', async () => {
    const { transport } = scripted(
      page([member('UFAKE0001')], 'cursor-a'),
      page([member('UFAKE0002', { has_2fa: null })]),
    );
    const result = expectComplete(await collectUsers(options(transport)));
    assert.equal(result.twoFactorFieldVisibility, 'visibility_unverified');
    assert.ok(result.observations.every((o) => o.slackNativeTwoFactor === 'unknown'));
  });
});

describe('account state', () => {
  it('classifies deactivated and bot accounts and leaves everything else unknown', async () => {
    const { transport } = scripted(
      page([
        member('UFAKE0001', { deleted: true }),
        member('BFAKE0002', { is_bot: true }),
        member('USLACKBOT', { is_bot: false }),
        member('BFAKE0004', { is_bot: true, deleted: true }),
        member('UFAKE0005'),
        { id: 'UFAKE0006', team_id: WORKSPACE_ID },
        member('UFAKE0007', { deleted: 'no', is_bot: 1 }),
      ]),
    );
    const result = expectComplete(await collectUsers(options(transport)));
    assert.deepEqual(
      result.observations.map((o) => [o.userId, o.accountState]),
      [
        ['UFAKE0001', 'deactivated'],
        ['BFAKE0002', 'bot'],
        ['USLACKBOT', 'bot'],
        ['BFAKE0004', 'deactivated'],
        ['UFAKE0005', 'unknown'],
        ['UFAKE0006', 'unknown'],
        ['UFAKE0007', 'unknown'],
      ],
    );
  });
});

describe('validation', () => {
  it('rejects a member from another workspace', async () => {
    const { transport } = scripted(page([member('UFAKE0001'), member('UFAKE0002', { team_id: 'TFAKE9999' })]));
    expectIncomplete(await collectUsers(options(transport)), 'workspace_mismatch');
  });

  it('rejects a non-JSON body', async () => {
    const { transport } = scripted({ status: 200, headers: {}, body: '<html>not json</html>' });
    expectIncomplete(await collectUsers(options(transport)), 'invalid_json');
  });

  const malformedBodies: Array<[string, unknown]> = [
    ['array body', []],
    ['null body', null],
    ['missing ok', { members: [] }],
    ['ok not boolean', { ok: 'true', members: [] }],
    ['members missing', { ok: true }],
    ['members not array', { ok: true, members: {} }],
    ['member not object', { ok: true, members: ['UFAKE0001'] }],
    ['member id missing', { ok: true, members: [{ team_id: WORKSPACE_ID }] }],
    ['member id number', { ok: true, members: [{ id: 1, team_id: WORKSPACE_ID }] }],
    ['member id empty', { ok: true, members: [{ id: '', team_id: WORKSPACE_ID }] }],
    ['member id not an opaque ID', { ok: true, members: [{ id: 'person@example.invalid', team_id: WORKSPACE_ID }] }],
    ['team_id missing', { ok: true, members: [{ id: 'UFAKE0001' }] }],
    ['team_id number', { ok: true, members: [{ id: 'UFAKE0001', team_id: 7 }] }],
    ['response_metadata not object', { ok: true, members: [], response_metadata: 'x' }],
    ['next_cursor not string', { ok: true, members: [], response_metadata: { next_cursor: 5 } }],
  ];
  for (const [label, body] of malformedBodies) {
    it(`rejects malformed body: ${label}`, async () => {
      const { transport } = scripted(json(body));
      expectIncomplete(await collectUsers(options(transport)), 'invalid_body');
    });
  }

  it('reports ok:false with an allowlisted Slack error code', async () => {
    const { transport } = scripted(json({ ok: false, error: 'missing_scope' }));
    const result = expectIncomplete(await collectUsers(options(transport)), 'slack_error');
    assert.equal(result.error.slackError, 'missing_scope');
  });

  it('does not echo an unrecognised Slack error string', async () => {
    const { transport } = scripted(json({ ok: false, error: 'CANARY_ERROR_TEXT' }));
    const result = expectIncomplete(await collectUsers(options(transport)), 'slack_error');
    assert.equal(result.error.slackError, 'other');
  });

  it('rejects invalid configuration without calling the transport', async () => {
    const cases = [
      { workspaceId: '' },
      { workspaceId: 'not a team id' },
      { token: '' },
      { token: 'xoxp-with\nnewline' },
      { maxPages: 0 },
      { maxPages: 1.5 },
      { maxRetryWaitSeconds: -1 },
    ];
    for (const extra of cases) {
      const { transport, requests } = scripted();
      const result = await collectUsers(options(transport, extra));
      assert.equal(result.status, 'incomplete');
      assert.equal((result as IncompleteResult).error.code, 'invalid_config');
      assert.equal(requests.length, 0);
    }
  });
});

describe('HTTP failures', () => {
  for (const status of [401, 403]) {
    it(`maps ${status} to auth_failed`, async () => {
      const { transport } = scripted({ status, headers: {}, body: 'denied' });
      const result = expectIncomplete(await collectUsers(options(transport)), 'auth_failed');
      assert.equal(result.error.httpStatus, status);
    });
  }

  for (const status of [500, 502, 503]) {
    it(`maps ${status} to server_error`, async () => {
      const { transport } = scripted({ status, headers: {}, body: 'upstream failure' });
      const result = expectIncomplete(await collectUsers(options(transport)), 'server_error');
      assert.equal(result.error.httpStatus, status);
    });
  }

  it('maps other statuses to unexpected_status', async () => {
    const { transport } = scripted({ status: 404, headers: {}, body: '' });
    expectIncomplete(await collectUsers(options(transport)), 'unexpected_status');
  });

  it('marks a failure on a later page incomplete, withholding earlier observations', async () => {
    const { transport } = scripted(page([member('UFAKE0001')], 'cursor-a'), { status: 500, headers: {}, body: '' });
    const result = expectIncomplete(await collectUsers(options(transport)), 'server_error');
    assert.equal(result.pagesFetched, 1);
  });

  it('maps a thrown transport error to transport_error without its message', async () => {
    const transport = async () => {
      throw new Error(`socket failure for ${FAKE_TOKEN}`);
    };
    const result = expectIncomplete(await collectUsers(options(transport)), 'transport_error');
    assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(result).includes('socket'));
  });
});

describe('rate limiting', () => {
  const limited = (retryAfter?: string) => ({
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    body: '',
  });

  it('without an injected sleep, returns incomplete with a retry recommendation', async () => {
    const { transport, requests } = scripted(limited('30'));
    const result = expectIncomplete(await collectUsers(options(transport)), 'rate_limited');
    assert.equal(result.error.retryAfterSeconds, 30);
    assert.equal(requests.length, 1);
  });

  it('with an injected sleep, waits Retry-After once and retries the same cursor', async () => {
    const sleeps: number[] = [];
    const { transport, requests } = scripted(
      page([member('UFAKE0001')], 'cursor-a'),
      limited('3'),
      page([member('UFAKE0002')]),
    );
    const result = expectComplete(
      await collectUsers(options(transport, { sleep: async (ms) => void sleeps.push(ms) })),
    );
    assert.deepEqual(sleeps, [3000]);
    assert.equal(requests[1]?.url, requests[2]?.url);
    assert.equal(result.observations.length, 2);
  });

  it('retries at most once per collection', async () => {
    const sleeps: number[] = [];
    const { transport, requests } = scripted(limited('1'), limited('1'));
    const result = expectIncomplete(
      await collectUsers(options(transport, { sleep: async (ms) => void sleeps.push(ms) })),
      'rate_limited',
    );
    assert.deepEqual(sleeps, [1000]);
    assert.equal(requests.length, 2);
    assert.equal(result.error.retryAfterSeconds, 1);
  });

  it('does not wait longer than maxRetryWaitSeconds', async () => {
    const sleeps: number[] = [];
    const { transport } = scripted(limited('120'));
    const result = expectIncomplete(
      await collectUsers(options(transport, { sleep: async (ms) => void sleeps.push(ms), maxRetryWaitSeconds: 60 })),
      'rate_limited',
    );
    assert.deepEqual(sleeps, []);
    assert.equal(result.error.retryAfterSeconds, 120);
  });

  for (const header of [undefined, 'soon', '-1', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', '999999']) {
    it(`does not retry on missing/invalid Retry-After (${String(header)})`, async () => {
      const sleeps: number[] = [];
      const { transport } = scripted(limited(header));
      const result = expectIncomplete(
        await collectUsers(options(transport, { sleep: async (ms) => void sleeps.push(ms) })),
        'rate_limited',
      );
      assert.deepEqual(sleeps, []);
      assert.equal(result.error.retryAfterSeconds, undefined);
    });
  }
});

describe('duplicates', () => {
  it('drops identical observations of the same (team_id, id)', async () => {
    const { transport } = scripted(
      page([member('UFAKE0001', { has_2fa: true })], 'cursor-a'),
      page([member('UFAKE0001', { has_2fa: true, real_name: 'CANARY_NAME' }), member('UFAKE0002')]),
    );
    const result = expectComplete(await collectUsers(options(transport)));
    assert.deepEqual(result.observations.map((o) => o.userId), ['UFAKE0001', 'UFAKE0002']);
    assert.equal(result.duplicatesDropped, 1);
  });

  it('rejects conflicting observations of the same (team_id, id)', async () => {
    const { transport } = scripted(
      page([member('UFAKE0001', { has_2fa: true })], 'cursor-a'),
      page([member('UFAKE0001', { has_2fa: false })]),
    );
    expectIncomplete(await collectUsers(options(transport)), 'conflicting_duplicate');
  });
});

describe('non-leakage', () => {
  const canaries = ['CANARY_NAME_7F3A', 'canary-7f3a@example.invalid', 'CANARY_TITLE', 'CANARY_TZ', FAKE_TOKEN];
  const noisyMember = (id: string) =>
    member(id, {
      name: 'CANARY_NAME_7F3A',
      real_name: 'CANARY_NAME_7F3A',
      tz: 'CANARY_TZ',
      has_2fa: true,
      profile: { email: 'canary-7f3a@example.invalid', title: 'CANARY_TITLE', real_name: 'CANARY_NAME_7F3A' },
    });

  function assertNoCanaries(value: unknown): void {
    const serialized = JSON.stringify(value);
    for (const canary of canaries) assert.ok(!serialized.includes(canary), `leaked ${canary}`);
  }

  it('emits only IDs, source, and classifications for each member', async () => {
    const { transport } = scripted(page([noisyMember('UFAKE0001')]));
    const result = expectComplete(await collectUsers(options(transport)));
    assertNoCanaries(result);
    assert.deepEqual(Object.keys(result.observations[0] ?? {}).sort(), [
      'accountState',
      'slackNativeTwoFactor',
      'source',
      'teamId',
      'userId',
    ]);
  });

  it('keeps token and body contents out of every failure result', async () => {
    const failures = [
      { status: 500, headers: {}, body: `CANARY_NAME_7F3A ${FAKE_TOKEN}` },
      { status: 401, headers: {}, body: FAKE_TOKEN },
      { status: 200, headers: {}, body: `not json CANARY_TITLE ${FAKE_TOKEN}` },
      json({ ok: false, error: FAKE_TOKEN }),
      page([noisyMember('UFAKE0001'), { ...noisyMember('UFAKE0002'), team_id: 'TFAKE9999' }]),
      page([{ ...noisyMember('UFAKE0003'), id: 'CANARY_NAME_7F3A' }]),
    ];
    for (const failure of failures) {
      const { transport } = scripted(failure);
      const result = await collectUsers(options(transport));
      assert.equal(result.status, 'incomplete');
      assertNoCanaries(result);
    }
  });

  it('does not echo a malformed workspaceId (for example a mis-pasted token)', async () => {
    const { transport } = scripted();
    const result = await collectUsers(options(transport, { workspaceId: FAKE_TOKEN }));
    assert.equal(result.status, 'incomplete');
    assert.equal(result.workspaceId, '');
    assertNoCanaries(result);
  });

  it('never rejects, so no exception can carry response data', async () => {
    const transport = async () => {
      throw new Error(FAKE_TOKEN);
    };
    await assert.doesNotReject(collectUsers(options(transport)));
  });
});
