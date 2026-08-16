/**
 * Errors from GitHub's GraphQL API are returned in an `errors` array on an
 * otherwise-successful HTTP 200 response, so they surface as
 * `GraphqlResponseError` rather than Octokit's `RequestError`. Notably they
 * carry no `status` property, which means `isRequestError` never matches them.
 *
 * As with `isRequestError`, an `instanceof` check is unreliable here, so this
 * typeguard checks structurally for the only part we care about.
 */
export interface GraphqlError {
  type?: string;
  message: string;
}

export function isGraphqlResponseError(
  error: Error,
): error is Error & { errors: GraphqlError[] } {
  return (
    'errors' in error &&
    Array.isArray((error as Error & { errors?: unknown }).errors)
  );
}
