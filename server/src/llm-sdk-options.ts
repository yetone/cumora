/** Tolerance settings shared by every OpenAI SDK client the server builds
 *  (the sub2api-routed client, the legacy fallback, and the LiteLLM gateway
 *  client). Production has surfaced "all four agents 502'd at once →
 *  every run failed → fingerprint locks them out" sequences caused by
 *  brief upstream flakiness on sub2api / the model provider. The OpenAI
 *  SDK retries on 5xx + 408 + 429 + network errors out of the box, but
 *  its default ceiling (2) is too thin for the bursty 502 windows we
 *  see; 5 absorbs short outages without making the wall-clock pathological.
 *  Timeout is 5 min — model responses (especially with reasoning) can
 *  legitimately take a couple minutes; the SDK aborts and retries within
 *  this budget.
 *
 *  Lives in its own module so provider modules can share it without
 *  importing llm.ts (which pulls in the DB pool). */
export const SDK_MAX_RETRIES = 5
export const SDK_TIMEOUT_MS = 5 * 60_000
