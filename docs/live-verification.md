# Live check: scope and remaining questions

**Observed:** 2026-09-29T00:19:05.565Z (September 28 in US Eastern time).
**Connector revision:** `22c1a5a85dcbcd56331976d9676261fcef57ae32`.
**Authorization:** workspace owner supplied a scoped user token through a shared credential vault for this read-only smoke test.

## Result

- Slack `auth.test` authenticated a user token and matched the intended workspace.
- Granted scopes were `users:read` and `identify`. Slack [documents `identify`](https://docs.slack.dev/reference/scopes/identify/) as an implicit/background identity scope on user tokens.
- The actual `collectUsers` connector and `createFetchTransport` completed a one-page `users.list` scan with normal pagination termination. No duplicate observations or workspace mismatches were encountered.
- The authenticated caller's returned member record identified it as an admin/owner. A boolean `has_2fa` field was visible in the returned member set. Other entries omitted it; those correctly remained `unknown`, not `disabled`.
- The retained aggregate evidence does not establish whether that boolean belonged to the caller or another human. It also does not classify the entries that omitted the field. This check therefore does not demonstrate visibility of other humans' 2FA settings.
- Only aggregate counts, booleans and safe status codes were retained. No token, raw API response, real member/workspace identifiers, names, emails or profile data were saved in this repository or its verification note.

## Scope of the check

The external operator harness limited a run to one identity call plus at most three member pages, a 30-second overall request-admission window, 10-second request timeouts clamped to the remaining window, and a 1 MiB response-body limit. It supplied those bounds around the connector's existing fetch transport, did not enable the optional sleep/retry, and used no write APIs. The successful run needed one identity request and one member-page request.

These wrapper protections are not new guarantees of the package's default transport. In particular, this check does not qualify arbitrary injected transports or production-scale resource limits.

## Not established

- No live multi-page pagination, rate-limit response, non-admin comparison, Enterprise Grid behavior, or cross-workspace generality was tested. Existing deterministic tests cover synthetic pagination and error handling.
- Field presence does not prove every member's 2FA state is observable. It does not establish SSO-provider MFA or overall compliance.
- No live response fixture was recorded. Checked-in tests remain synthetic, not recorded mocks.
