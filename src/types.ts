import type * as octokit from '@octokit/types';
import type { PullRequestEvent } from '@octokit/webhooks-types/schema';

export type PullRequestResponse =
  octokit.Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response'];

/**
 * A pull request as it reaches us, either from the REST API when listing a
 * branch's pull requests or from a webhook payload. The two shapes are close
 * but not identical, so consumers must stick to the fields common to both.
 */
export type PullRequest =
  PullRequestResponse['data'] | PullRequestEvent['pull_request'];

/**
 * A pull request whose head repository is known to still exist. A fork can be
 * deleted while its pull request is open, so `AutoUpdater.update` checks for
 * this before handing the pull request to an update strategy — which lets the
 * strategies read `head.repo` without repeating the check.
 */
export type PullRequestWithHeadRepo = PullRequest & {
  head: { repo: NonNullable<PullRequest['head']['repo']> };
};
