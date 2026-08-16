import { isGraphqlResponseError } from '../../src/helpers/isGraphqlResponseError';
import { isRequestError } from '../../src/helpers/isRequestError';

describe('isGraphqlResponseError', () => {
  test('matches an error carrying a GraphQL `errors` array', () => {
    const error = new Error('Request failed due to following response errors');
    (error as any).errors = [{ type: 'FORBIDDEN', message: 'nope' }];

    expect(isGraphqlResponseError(error)).toEqual(true);
  });

  test('matches an error with an empty `errors` array', () => {
    const error = new Error('boom');
    (error as any).errors = [];

    // Still a GraphQL-shaped error; callers decide what an empty list means.
    expect(isGraphqlResponseError(error)).toEqual(true);
  });

  test('does not match a plain error', () => {
    expect(isGraphqlResponseError(new Error('boom'))).toEqual(false);
  });

  test('does not match when `errors` is not an array', () => {
    const error = new Error('boom');
    (error as any).errors = 'not-an-array';

    expect(isGraphqlResponseError(error)).toEqual(false);
  });

  test('does not match an Octokit RequestError', () => {
    const error = new Error('Forbidden');
    (error as any).status = 403;

    expect(isGraphqlResponseError(error)).toEqual(false);
  });

  // The two guards are mutually exclusive in practice: GraphQL errors arrive on
  // an HTTP 200 and so carry no `status`. This is why REST-shaped error
  // handling alone cannot classify a failed rebase.
  test('is disjoint from isRequestError for a GraphQL error', () => {
    const error = new Error('Request failed due to following response errors');
    (error as any).errors = [{ type: 'FORBIDDEN', message: 'nope' }];

    expect(isGraphqlResponseError(error)).toEqual(true);
    expect(isRequestError(error)).toEqual(false);
  });
});
