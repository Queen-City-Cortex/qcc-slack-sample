/** Minimal HTTP boundary. Tests inject a fake; production can use `createFetchTransport`. */
export interface TransportRequest {
  readonly method: 'GET';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TransportResponse {
  readonly status: number;
  /** Header names are expected in lower case (e.g. `retry-after`). */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Raw body text. It is parsed and discarded; never surfaced in results. */
  readonly body: string;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface CollectOptions {
  /** Slack workspace (team) ID the caller expects every member to belong to. */
  readonly workspaceId: string;
  /** Slack token with `users:read`. Sent only in the Authorization header. */
  readonly token: string;
  readonly transport: Transport;
  /** Maximum number of pages to fetch before stopping as incomplete. Default 100. */
  readonly maxPages?: number;
  /**
   * Injected sleep used for at most one rate-limit retry per collection. When
   * omitted, a 429 ends the collection as incomplete with a retry recommendation.
   */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Longest Retry-After (seconds) the collector will wait via `sleep`. Default 60. */
  readonly maxRetryWaitSeconds?: number;
}

export const SOURCE = 'slack_users_list' as const;

/** Slack-native 2FA only. This is not SSO / identity-provider MFA. */
export type TwoFactorObservation = 'enabled' | 'disabled' | 'unknown';

/**
 * `deactivated`: Slack reports `deleted: true`.
 * `bot`: Slack reports `is_bot: true` (or the built-in Slackbot ID).
 * `unknown`: neither of the above could be established. This connector does
 * not infer whether an account is active, invited, or pending.
 */
export type AccountState = 'deactivated' | 'bot' | 'unknown';

export interface UserObservation {
  readonly source: typeof SOURCE;
  readonly teamId: string;
  readonly userId: string;
  readonly slackNativeTwoFactor: TwoFactorObservation;
  readonly accountState: AccountState;
}

/**
 * `observed`: at least one member carried a non-null `has_2fa` value.
 * `visibility_unverified`: members were returned but none carried `has_2fa`;
 *   the token may lack admin visibility. This is not evidence of disabled 2FA.
 * `not_assessed`: no members were returned, so visibility cannot be judged.
 */
export type TwoFactorFieldVisibility = 'observed' | 'visibility_unverified' | 'not_assessed';

export type CollectErrorCode =
  | 'invalid_config'
  | 'transport_error'
  | 'auth_failed'
  | 'server_error'
  | 'unexpected_status'
  | 'rate_limited'
  | 'invalid_json'
  | 'invalid_body'
  | 'slack_error'
  | 'workspace_mismatch'
  | 'conflicting_duplicate'
  | 'repeated_cursor'
  | 'page_cap_exceeded';

export interface CollectError {
  readonly code: CollectErrorCode;
  /** HTTP status when the failure came from a non-200 response. */
  readonly httpStatus?: number;
  /** Seconds suggested by a valid Retry-After header on a 429. */
  readonly retryAfterSeconds?: number;
  /** Slack `error` value, only if it is on a known allowlist; otherwise `other`. */
  readonly slackError?: string;
}

export interface CompleteResult {
  readonly status: 'complete';
  readonly source: typeof SOURCE;
  readonly workspaceId: string;
  readonly pagesFetched: number;
  readonly twoFactorFieldVisibility: TwoFactorFieldVisibility;
  readonly duplicatesDropped: number;
  readonly observations: readonly UserObservation[];
}

/** Partial observations are deliberately withheld: incomplete means no evidence. */
export interface IncompleteResult {
  readonly status: 'incomplete';
  readonly source: typeof SOURCE;
  readonly workspaceId: string;
  readonly pagesFetched: number;
  readonly error: CollectError;
}

export type CollectResult = CompleteResult | IncompleteResult;
