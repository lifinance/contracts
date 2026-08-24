/**
 * Strip credentialed endpoints out of text that leaves the job log.
 *
 * Viem embeds the full endpoint in `error.message`, the Mongo driver can echo its connection
 * string, and provider credentials ride in query strings — while Slack sits outside the
 * `::add-mask::` redaction that protects the workflow log. Anything derived from an error
 * message must therefore pass through here before it is published.
 */

/** Longest error text kept in an alert line; viem messages run to several hundred chars. */
export const MAX_REASON_LENGTH = 180

/**
 * Marker left where an endpoint was. Square brackets, not angle brackets: every consumer of
 * this module publishes to Slack, which parses `<...>` as a link element and would mangle the
 * marker in the very alert it exists to make safe.
 */
const REDACTED_URL_MARKER = '[redacted-url]'

/**
 * Replace every `scheme://…` token with {@link REDACTED_URL_MARKER}, leaving the rest of the
 * text intact. Length and whitespace are left alone so callers that do their own capping
 * (e.g. a grouped digest) do not lose text to a cap they did not choose.
 *
 * @param message - Raw text that may embed an endpoint.
 * @returns The same text with `scheme://…` tokens replaced.
 */
export function redactUrls(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, REDACTED_URL_MARKER)
}

/**
 * Makes an error message safe to post outside the job log: redacts endpoints, collapses the
 * rest to one line, and caps the length. Only the reason is redacted, never the whole alert:
 * the surrounding links are what make it actionable.
 *
 * @param message - Raw error message.
 * @returns A single-line, length-capped reason with `scheme://…` tokens replaced.
 */
export function redactErrorReason(message: string): string {
  const redacted = redactUrls(message).replace(/\s+/g, ' ').trim()
  return redacted.length > MAX_REASON_LENGTH
    ? `${redacted.slice(0, MAX_REASON_LENGTH)}…`
    : redacted
}
