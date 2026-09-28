import {
  SOURCE,
  type AccountState,
  type CollectError,
  type CollectOptions,
  type CollectResult,
  type TransportResponse,
  type TwoFactorObservation,
  type UserObservation,
} from './types.ts';

const ENDPOINT = 'https://slack.com/api/users.list';
const PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CEILING = 1000;
const DEFAULT_MAX_RETRY_WAIT_SECONDS = 60;
/** Retry-After values above this are treated as invalid rather than recommended. */
const RETRY_AFTER_CEILING_SECONDS = 3600;
const SLACKBOT_ID = 'USLACKBOT';

/** Slack IDs are short upper-case alphanumerics; anything else is not echoed. */
const OPAQUE_ID = /^[A-Z0-9]{1,64}$/;

/** Documented Slack error codes that are safe to surface verbatim. */
const KNOWN_SLACK_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'org_login_required',
  'ekm_access_denied',
  'not_allowed_token_type',
  'invalid_cursor',
  'limit_required',
  'ratelimited',
  'request_timeout',
  'fatal_error',
  'internal_error',
  'service_unavailable',
  'team_added_to_org',
]);

/** Thrown internally to unwind; always converted to an IncompleteResult. */
class CollectFailure {
  readonly error: CollectError;
  constructor(error: CollectError) {
    this.error = error;
  }
}

interface ParsedPage {
  readonly members: readonly UserObservation[];
  readonly twoFactorFieldPresent: boolean;
  readonly nextCursor: string;
}

/**
 * Reads every page of `users.list` for one workspace. Never rejects: all
 * failures become an `incomplete` result carrying a safe error code only.
 */
export async function collectUsers(options: CollectOptions): Promise<CollectResult> {
  // Echo the caller's workspace ID only once it is known to be an opaque ID.
  const workspaceId =
    typeof options.workspaceId === 'string' && OPAQUE_ID.test(options.workspaceId) ? options.workspaceId : '';
  let pagesFetched = 0;
  try {
    const config = validateConfig(options);
    const seenCursors = new Set<string>();
    const byKey = new Map<string, UserObservation>();
    let duplicatesDropped = 0;
    let anyTwoFactorField = false;
    let retryAvailable = true;
    let cursor = '';

    for (;;) {
      if (pagesFetched >= config.maxPages) throw new CollectFailure({ code: 'page_cap_exceeded' });

      let response = await send(options, cursor);
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers['retry-after']);
        const canWait =
          retryAvailable &&
          options.sleep !== undefined &&
          retryAfterSeconds !== undefined &&
          retryAfterSeconds <= config.maxRetryWaitSeconds;
        if (!canWait) throw rateLimited(retryAfterSeconds);
        retryAvailable = false;
        await options.sleep!(retryAfterSeconds! * 1000);
        response = await send(options, cursor);
        if (response.status === 429) throw rateLimited(parseRetryAfter(response.headers['retry-after']));
      }

      const parsed = parsePage(response, workspaceId);
      pagesFetched += 1;
      anyTwoFactorField ||= parsed.twoFactorFieldPresent;

      for (const observation of parsed.members) {
        const key = `${observation.teamId}:${observation.userId}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, observation);
        } else if (sameObservation(existing, observation)) {
          duplicatesDropped += 1;
        } else {
          throw new CollectFailure({ code: 'conflicting_duplicate' });
        }
      }

      if (parsed.nextCursor === '') break;
      if (seenCursors.has(parsed.nextCursor)) throw new CollectFailure({ code: 'repeated_cursor' });
      seenCursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }

    const observations = [...byKey.values()];
    return {
      status: 'complete',
      source: SOURCE,
      workspaceId,
      pagesFetched,
      twoFactorFieldVisibility:
        observations.length === 0 ? 'not_assessed' : anyTwoFactorField ? 'observed' : 'visibility_unverified',
      duplicatesDropped,
      observations,
    };
  } catch (caught) {
    const error: CollectError = caught instanceof CollectFailure ? caught.error : { code: 'transport_error' };
    return { status: 'incomplete', source: SOURCE, workspaceId, pagesFetched, error };
  }
}

function validateConfig(options: CollectOptions): { maxPages: number; maxRetryWaitSeconds: number } {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRetryWaitSeconds = options.maxRetryWaitSeconds ?? DEFAULT_MAX_RETRY_WAIT_SECONDS;
  const valid =
    typeof options.workspaceId === 'string' &&
    OPAQUE_ID.test(options.workspaceId) &&
    typeof options.token === 'string' &&
    /^[\x21-\x7e]+$/.test(options.token) &&
    typeof options.transport === 'function' &&
    Number.isInteger(maxPages) &&
    maxPages >= 1 &&
    maxPages <= MAX_PAGES_CEILING &&
    Number.isInteger(maxRetryWaitSeconds) &&
    maxRetryWaitSeconds >= 0 &&
    maxRetryWaitSeconds <= RETRY_AFTER_CEILING_SECONDS &&
    (options.sleep === undefined || typeof options.sleep === 'function');
  if (!valid) throw new CollectFailure({ code: 'invalid_config' });
  return { maxPages, maxRetryWaitSeconds };
}

async function send(options: CollectOptions, cursor: string): Promise<TransportResponse> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor !== '') params.set('cursor', cursor);
  try {
    return await options.transport({
      method: 'GET',
      url: `${ENDPOINT}?${params.toString()}`,
      headers: { authorization: `Bearer ${options.token}` },
    });
  } catch {
    // The thrown value may mention the request or token; drop it entirely.
    throw new CollectFailure({ code: 'transport_error' });
  }
}

function parseRetryAfter(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,5}$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds <= RETRY_AFTER_CEILING_SECONDS ? seconds : undefined;
}

function rateLimited(retryAfterSeconds: number | undefined): CollectFailure {
  return new CollectFailure(
    retryAfterSeconds === undefined ? { code: 'rate_limited' } : { code: 'rate_limited', retryAfterSeconds },
  );
}

function parsePage(response: TransportResponse, workspaceId: string): ParsedPage {
  const { status } = response;
  if (status === 401 || status === 403) throw new CollectFailure({ code: 'auth_failed', httpStatus: status });
  if (status >= 500 && status <= 599) throw new CollectFailure({ code: 'server_error', httpStatus: status });
  if (status !== 200) throw new CollectFailure({ code: 'unexpected_status', httpStatus: status });

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new CollectFailure({ code: 'invalid_json' });
  }
  if (!isRecord(body) || typeof body.ok !== 'boolean') throw invalidBody();
  if (!body.ok) {
    const slackError = typeof body.error === 'string' && KNOWN_SLACK_ERRORS.has(body.error) ? body.error : 'other';
    throw new CollectFailure({ code: 'slack_error', slackError });
  }
  if (!Array.isArray(body.members)) throw invalidBody();

  let twoFactorFieldPresent = false;
  const members = body.members.map((raw: unknown): UserObservation => {
    if (!isRecord(raw)) throw invalidBody();
    const { id, team_id: teamId } = raw;
    if (typeof id !== 'string' || !OPAQUE_ID.test(id)) throw invalidBody();
    if (typeof teamId !== 'string' || !OPAQUE_ID.test(teamId)) throw invalidBody();
    if (teamId !== workspaceId) throw new CollectFailure({ code: 'workspace_mismatch' });
    if (raw.has_2fa !== undefined && raw.has_2fa !== null) twoFactorFieldPresent = true;
    return {
      source: SOURCE,
      teamId,
      userId: id,
      slackNativeTwoFactor: classifyTwoFactor(raw.has_2fa),
      accountState: classifyAccount(id, raw.deleted, raw.is_bot),
    };
  });

  return { members, twoFactorFieldPresent, nextCursor: readNextCursor(body.response_metadata) };
}

function readNextCursor(metadata: unknown): string {
  if (metadata === undefined) return '';
  if (!isRecord(metadata)) throw invalidBody();
  const { next_cursor: next } = metadata;
  if (next === undefined) return '';
  if (typeof next !== 'string') throw invalidBody();
  return next;
}

function classifyTwoFactor(value: unknown): TwoFactorObservation {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  if (value === undefined || value === null) return 'unknown';
  throw invalidBody();
}

function classifyAccount(id: string, deleted: unknown, isBot: unknown): AccountState {
  if (deleted === true) return 'deactivated';
  if (isBot === true || id === SLACKBOT_ID) return 'bot';
  return 'unknown';
}

function sameObservation(a: UserObservation, b: UserObservation): boolean {
  return a.slackNativeTwoFactor === b.slackNativeTwoFactor && a.accountState === b.accountState;
}

function invalidBody(): CollectFailure {
  return new CollectFailure({ code: 'invalid_body' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
