import * as ghCore from '@actions/core';
import { ConfigLoader } from '../config-loader';
import { GitHubService, MergeParameters } from '../services/GitHubService';
import { Output } from '../Output';
import { isRequestError } from '../helpers/isRequestError';
import { isGraphqlResponseError } from '../helpers/isGraphqlResponseError';
import { errorMessage } from '../helpers/errorMessage';
import type { PullRequestWithHeadRepo } from '../types';

export interface UpdateStrategy {
  readonly name: string;
  execute(
    sourceEventOwner: string,
    pull: PullRequestWithHeadRepo,
  ): Promise<boolean>;
}

abstract class BaseUpdateStrategy implements UpdateStrategy {
  abstract readonly name: string;

  constructor(
    protected config: ConfigLoader,
    protected github: GitHubService,
  ) {}

  abstract performUpdate(pull: PullRequestWithHeadRepo): Promise<void>;

  async execute(
    sourceEventOwner: string,
    pull: PullRequestWithHeadRepo,
  ): Promise<boolean> {
    const retryCount = this.config.retryCount();
    const retrySleep = this.config.retrySleep();
    const mergeOptsOwner = pull.head.repo.owner.login;

    const sleep = (timeMs: number) =>
      new Promise((resolve) => setTimeout(resolve, timeMs));

    let retries = 0;

    while (true) {
      try {
        ghCore.info(`Attempting branch update...`);
        await this.performUpdate(pull);
        ghCore.setOutput(Output.Conflicted, false);
        break;
      } catch (e: unknown) {
        if (this.isAuthorisationError(e)) {
          ghCore.error(`Authorisation error: ${errorMessage(e)}`);
          ghCore.setOutput(Output.Conflicted, false);
          return false;
        }

        if (this.isPermissionError(e) && sourceEventOwner !== mergeOptsOwner) {
          ghCore.error(`Fork write access error: ${errorMessage(e)}`);
          ghCore.setOutput(Output.Conflicted, false);
          return false;
        }

        if (this.isConflictError(e)) {
          await this.handleConflict(pull, e);
          return false;
        }

        ghCore.error(
          `Caught error trying to update branch: ${errorMessage(e)}`,
        );

        if (retries < retryCount) {
          ghCore.info(`Update failed, retrying in ${retrySleep}ms...`);
          retries++;
          await sleep(retrySleep);
        } else {
          ghCore.setOutput(Output.Conflicted, false);
          throw e;
        }
      }
    }
    return true;
  }

  /**
   * Octokit itself raises this when no usable token was supplied, so it is
   * always a `RequestError` regardless of which API the strategy calls.
   */
  private isAuthorisationError(e: unknown): boolean {
    return (
      e instanceof Error &&
      isRequestError(e) &&
      e.message.includes('Parameter token or opts.auth is required')
    );
  }

  /**
   * REST reports a missing write permission as HTTP 403. GraphQL returns
   * HTTP 200 with a typed error instead, so `isRequestError` never matches it
   * and the type has to be inspected directly.
   */
  private isPermissionError(e: unknown): boolean {
    if (!(e instanceof Error)) {
      return false;
    }

    if (isRequestError(e) && e.status === 403) {
      return true;
    }

    if (isGraphqlResponseError(e)) {
      return e.errors.some(
        (err) => err.type === 'FORBIDDEN' || err.type === 'UNAUTHORIZED',
      );
    }

    return false;
  }

  /**
   * REST returns a literal 'Merge conflict' message, so that check stays exact
   * — matching any error mentioning 'conflict' would misclassify unrelated
   * failures as conflicts and skip the retry logic. GitHub controls the
   * wording of the GraphQL equivalent, so match loosely there, but only within
   * a GraphQL error's own messages.
   */
  private isConflictError(e: unknown): boolean {
    if (!(e instanceof Error)) {
      return false;
    }

    if (isGraphqlResponseError(e)) {
      return e.errors.some((err) => /conflict/i.test(err.message ?? ''));
    }

    return e.message.includes('Merge conflict');
  }

  private async handleConflict(pull: PullRequestWithHeadRepo, error: unknown) {
    ghCore.setOutput(Output.Conflicted, true);
    const action = this.config.mergeConflictAction();
    const label = this.config.mergeConflictLabel();

    if (action === 'ignore') {
      ghCore.info('Merge conflict detected, skipping update.');
      return;
    }

    if (action === 'label') {
      const owner = pull.head.repo.owner.login;
      const repo = pull.head.repo.name;

      const { data: prData } = await this.github.getPullRequest(
        owner,
        repo,
        pull.number,
      );
      const currentLabels = prData.labels.map((l) => l.name).filter(Boolean);

      if (!currentLabels.includes(label)) {
        const labelSet = new Set([...currentLabels, label]);

        if (this.config.pullRequestFilter() === 'labelled') {
          this.config
            .pullRequestLabels()
            .forEach((l: string) => labelSet.delete(l));
        }

        const newLabels = Array.from(labelSet) as string[];
        await this.github.updateIssueLabels(
          owner,
          repo,
          pull.number,
          newLabels,
        );
        await this.github.createIssueComment(
          owner,
          repo,
          pull.number,
          `This pull request has a merge conflict with the base branch! Please resolve the conflict manually, remove the conflict label and re-add the filter label (if applicable).`,
        );
      }
      return; // Exit here if action was label
    }

    // If the action is 'fail', log the error and throw it
    ghCore.error('Merge conflict error trying to update branch');
    throw error;
  }
}

export class MergeUpdateStrategy extends BaseUpdateStrategy {
  readonly name = 'merge';

  async performUpdate(pull: PullRequestWithHeadRepo): Promise<void> {
    const mergeMsg = this.config.mergeMsg();
    const mergeOpts: MergeParameters = {
      owner: pull.head.repo.owner.login,
      repo: pull.head.repo.name,
      base: pull.head.ref,
      head: pull.base.ref,
    };

    if (mergeMsg) mergeOpts.commit_message = mergeMsg;

    const mergeResp = await this.github.mergeBranch(mergeOpts);

    // Octokit types this response as a 201, but the merge endpoint also
    // returns a 204 when the branch is already up to date.
    // See https://docs.github.com/en/rest/branches/branches#merge-a-branch
    const status: number = mergeResp.status;

    if (status === 200 || status === 201) {
      ghCore.info(`Branch update successful, new HEAD: ${mergeResp.data.sha}.`);
    } else if (status === 204) {
      ghCore.info('Branch update not required, branch is already up-to-date.');
    }
  }
}

export class RebaseUpdateStrategy extends BaseUpdateStrategy {
  readonly name = 'rebase';

  async performUpdate(pull: PullRequestWithHeadRepo): Promise<void> {
    // The GraphQL mutation identifies the pull request by its node ID, which
    // both the REST list response and the webhook payload provide.
    if (!pull.node_id) {
      throw new Error(
        `Cannot rebase pull request #${pull.number}, it has no node ID.`,
      );
    }

    await this.github.rebaseBranch(pull.node_id);
    ghCore.info(`Branch update successful via rebase.`);
  }
}
