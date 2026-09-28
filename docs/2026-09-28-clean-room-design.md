# Slack user 2FA observation sample — design record

**Created:** 2026-09-28, before connector implementation. **Status:** design, not a claim of live Slack verification.

## Purpose and provenance

Build a small read-only TypeScript connector from Slack's public Web API documentation and independently authored synthetic tests. This repository must not contain code, fixtures, prompts, or data from a former employer or customer. No real workspace records, tokens, user names, emails, or profile objects belong in commits. This document records the design before the implementation.

## Bounded behavior

- Call only `https://slack.com/api/users.list` via an injected transport, with a caller-supplied token and single-workspace ID. `users:read` is the requested scope. Never put the bearer token in a URL or logs.
- Follow the returned cursor until it is absent or empty. A short page is not completion. Detect repeated cursors, invalid bodies, workspace-ID mismatches, and a configurable page cap. Fail closed or return explicitly incomplete; never present partial observations as complete.
- Output only IDs, a source marker, a Slack-native 2FA observation (`enabled`, `disabled`, `unknown`), and an account-state classification that does not guess whether someone has accepted an invitation. Missing/null `has_2fa` is `unknown`, not `disabled`.
- Slack documents `has_2fa` as visible only when an admin executes the call. Do not claim verified 2FA visibility until a consented admin-token smoke test confirms it. Slack-native 2FA is not equivalent to MFA at an SSO identity provider; this connector cannot declare overall MFA compliance.
- Bound 429 handling according to `Retry-After`, with injectable time for deterministic tests. Redact errors; avoid raw response objects in output. Scope excludes message search, DSR completeness claims, and any write API.

## Implementation and evidence gates

1. Commit this dated design before writing implementation code.
2. Implement a narrow, typed transport boundary and synthetic fixtures with no live network in CI. Test empty and multi-page responses, short page plus next cursor, missing/false 2FA, deactivated/bot identities, deduplication, workspace mismatch, malformed responses, 429, and auth errors.
3. Run typecheck, tests, and a secret/fixture review. Record the exact commands and results in the PR; do not call synthetic fixtures recorded vendor responses.
4. Obtain separate workspace-owner consent for any optional live smoke and separate approval before public release. If field visibility is unverified, describe it honestly rather than implying all users lack 2FA.

## Public references (consulted for this design)

- https://docs.slack.dev/reference/methods/users.list
- https://docs.slack.dev/reference/objects/user-object
- https://docs.slack.dev/reference/scopes/users.read
- https://docs.slack.dev/apis/web-api/rate-limits
- https://slack.com/help/articles/212221668-Mandatory-workspace-two-factor-authentication-
