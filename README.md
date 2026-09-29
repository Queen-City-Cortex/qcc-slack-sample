# slack-users-2fa-sample

A small, read-only TypeScript connector for Slack's
[`users.list`](https://docs.slack.dev/reference/methods/users.list) Web API method. For one workspace, it reports:

- the opaque Slack user ID and team ID,
- a **Slack-native** 2FA observation, and
- a conservative account-state classification.

It is a clean-room sample built from Slack's public documentation. The design was recorded first in
[`docs/2026-09-28-clean-room-design.md`](docs/2026-09-28-clean-room-design.md).

> **Status:** synthetic tests plus a bounded, consented live smoke check in one workspace. Admin-user
> `has_2fa` field visibility was observed; some records omitted the field and remain unknown.
> See the [live verification note](docs/live-verification.md) and [Limitations](#limitations).

## What it does not do

- It makes no write calls, message search, or requests to any endpoint other than `users.list`.
- It does not output names, emails, profiles, titles, time zones, or raw Slack responses.
- It does not log anything.
- It **does not assess SSO / identity-provider MFA.** Slack's `has_2fa` covers Slack's own two-factor
  authentication only. A user who signs in through SSO with strong MFA can still show `has_2fa: false`. This
  connector cannot show that an organization meets any MFA policy or compliance requirement.
- It does not work out whether an account is active, invited, or pending.

## Requirements

- Node.js 24 or later. Tests run TypeScript directly through Node's built-in type stripping.
- A Slack token with the **`users:read`** scope.
  - Slack documents `has_2fa` as visible **only when an admin runs the call**. With a non-admin token, the
    field is expected to be absent, and the result reports `twoFactorFieldVisibility: "visibility_unverified"`.
    A consented admin-user smoke check observed this field in one workspace; this does not establish
    availability for every member, workspace, or token. Slack may also include the implicit `identify` scope.
- A single-workspace (non-Enterprise-Grid-org) token. Any member whose `team_id` differs from the configured
  `workspaceId` makes the run fail as `workspace_mismatch`.

## Install and test

```sh
npm install         # dev-only: typescript, @types/node
npm test            # node --test, synthetic fixtures, no network
npm run typecheck   # tsc --noEmit (strict)
npm run build       # emits dist/ (gitignored)
```

## Usage

```ts
import { collectUsers, createFetchTransport } from 'slack-users-2fa-sample';

const result = await collectUsers({
  workspaceId: 'T0123456789',            // the workspace you expect
  token: process.env.SLACK_TOKEN!,       // supplied at invocation; never hard-code it
  transport: createFetchTransport(),     // or your own Transport
  // Optional:
  maxPages: 100,                         // incomplete if more pages remain after this many
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)), // enables ONE rate-limit retry
  maxRetryWaitSeconds: 60,               // longest Retry-After it will honour via sleep
});

if (result.status === 'complete') {
  // result.observations: [{ source, teamId, userId, slackNativeTwoFactor, accountState }]
} else {
  // result.error.code, plus optional httpStatus / retryAfterSeconds / slackError
}
```

### Running privately with an admin token

For an optional live smoke test, **get written consent from the workspace owner first**. Then:

1. Create or reuse a Slack app with the `users:read` user-token scope, installed by a workspace admin. Keep the
   token in your shell session or a local secret manager. **Do not** write it to a file in this repository, even
   though `.env*` and `*.token` are gitignored.
2. Run a scratch script outside the repository with the token injected by a secret manager or secure local environment, and print only aggregate counts. Do not place the token on a command line or print observations.
3. Do not commit, paste, or share raw output, tokens, or member identifiers. Retain only a reviewed aggregate
   verification note. The fixtures here remain synthetic; a live smoke check is not a recorded response fixture.
4. Revoke the token when you are done.

## Output contract

| Field | Values |
| --- | --- |
| `status` | `complete` only if pagination ended normally (cursor absent or empty). Otherwise `incomplete`. |
| `observations[].slackNativeTwoFactor` | `has_2fa === true` → `enabled`; `=== false` → `disabled`; missing or `null` → `unknown`; any other type fails the run as `invalid_body`. |
| `observations[].accountState` | `deleted: true` → `deactivated` (takes precedence); `is_bot: true` or `USLACKBOT` → `bot`; otherwise `unknown`. `unknown` does **not** mean active. |
| `twoFactorFieldVisibility` | `observed`: at least one member had a non-null `has_2fa`. `visibility_unverified`: members were returned, but none had the field. `not_assessed`: zero members were returned. |
| `duplicatesDropped` | Number of identical repeat observations of the same `(team_id, id)`. |

An `incomplete` result **never includes partial observations**. A failure on page 3 does not return pages 1–2,
so they can't be mistaken for a complete census.

### Error codes

`invalid_config`, `transport_error`, `auth_failed` (401/403), `server_error` (5xx), `unexpected_status`,
`rate_limited`, `invalid_json`, `invalid_body`, `slack_error`, `workspace_mismatch`, `conflicting_duplicate`,
`repeated_cursor`, `page_cap_exceeded`.

Errors never contain response bodies, exception messages, or the token. For `slack_error`, `slackError` holds
Slack's `error` value only when that value is on a fixed allowlist of documented codes, such as `missing_scope`
or `invalid_auth`. Any other value becomes `other`. The collector never rejects its promise.

### Behaviour details

- **Request:** `GET https://slack.com/api/users.list?limit=100[&cursor=…]` with
  `Authorization: Bearer <token>`. The token appears only in that header. `createFetchTransport` accepts only this
  endpoint and uses `redirect: "error"`, so a redirect cannot forward the header elsewhere.
- **Pagination:** the connector follows `response_metadata.next_cursor` until it is absent or empty. A short
  page does not end pagination. A repeated cursor gives `repeated_cursor`, and exceeding `maxPages` (default 100,
  ceiling 1000) gives `page_cap_exceeded`.
- **Validation:** the connector parses the body as `unknown` and checks it field by field. It requires
  `ok: true`, a `members` array, and string `id` and `team_id` values that look like opaque Slack IDs
  (`[A-Z0-9]+`). Each `team_id` must equal `workspaceId`.
- **Duplicates:** a repeat of the same `(team_id, id)` is dropped when its normalized observation is identical.
  If it conflicts (for example, `has_2fa` true on one page and false on another), the run fails with
  `conflicting_duplicate` instead of choosing one.
- **429:** a valid integer `Retry-After` from 0 to 3600 is returned as `retryAfterSeconds`. If `sleep` is
  injected and the value is within `maxRetryWaitSeconds`, the collector waits and retries the same cursor
  **once per run**. Otherwise, it stops as `rate_limited`. An invalid or missing `Retry-After` never triggers a
  retry.

## Fixtures: synthetic, not recorded

All test data in `test/` is hand-written: IDs such as `TFAKE0001` and `UFAKE0001`, a fake token string, and
obvious `CANARY_*` / `@example.invalid` strings. The canaries exist only to prove that names, emails, and
profiles are stripped. **None of it is a recorded Slack response.** Real Slack responses may have fields or
edge cases that these fixtures don't cover. Tests replace `globalThis.fetch` with a guard that fails the run if
anything tries to reach the network.

## Limitations

- **Live coverage is narrow.** One consented workspace returned a boolean `has_2fa` on a member and
  omitted it on other entries. The smoke check covered one terminal page, not live multi-page pagination
  or rate limiting. `visibility_unverified` or `unknown` must never be read as "2FA disabled."
- **Slack-native 2FA ≠ SSO MFA.** A `disabled` value is not evidence of missing MFA if the workspace uses SSO.
- **Enterprise Grid org-level tokens are unsupported.** Members from other workspaces fail the run as
  `workspace_mismatch`.
- **Only one rate-limit retry per run.** Large workspaces may need the caller to re-run later.
- **No partial results.** This is deliberate, but it means one bad page discards the whole run.
- **Response body size is not capped** by `createFetchTransport`. Wrap your own transport if you need a limit.
- **`accountState` is minimal:** guests (`is_restricted`), invitation state, and last activity are not
  reported.
