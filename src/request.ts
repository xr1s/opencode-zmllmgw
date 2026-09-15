/** Let OpenCode apply its normal exponential backoff instead of a Gateway-supplied delay. */
export function stripRateLimitRetryAfter(response: Response): Response {
  if (response.status !== 429) return response;
  if (
    !response.headers.has("retry-after") &&
    !response.headers.has("retry-after-ms")
  )
    return response;

  const headers = new Headers(response.headers);
  headers.delete("retry-after");
  headers.delete("retry-after-ms");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
