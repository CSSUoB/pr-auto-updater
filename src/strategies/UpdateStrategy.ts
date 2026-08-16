import * as ghCore from '@actions/core';
import { ConfigLoader } from '../config-loader';
import { GitHubService, MergeParameters } from '../services/GitHubService';
import { Output } from '../Output';
import { isRequestError } from '../helpers/isRequestError';

export interface UpdateStrategy {
  execute(sourceEventOwner: string, pull: any): Promise<boolean>;
}

abstract class BaseUpdateStrategy implements UpdateStrategy {
  constructor(
    protected config: ConfigLoader,
    protected github: GitHubService,
  ) {}

  abstract performUpdate(pull: any): Promise<void>;

  async execute(sourceEventOwner: string, pull: any): Promise<boolean> {
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
      } catch (e: any) {
        if (isRequestError(e)) {
          if (e.message.includes('Parameter token or opts.auth is required')) {
            ghCore.error(`Authorisation error: ${e.message}`);
            ghCore.setOutput(Output.Conflicted, false);
            return false;
          }
          if (e.status === 403 && sourceEventOwner !== mergeOptsOwner) {
            ghCore.error(`Fork write access error: ${e.message}`);
            ghCore.setOutput(Output.Conflicted, false);
            return false;
          }
        }

        if (
          e.message?.includes('Merge conflict') ||
          e.message?.includes('conflict')
        ) {
          await this.handleConflict(pull, e);
          return false;
        }

        ghCore.error(`Caught error trying to update branch: ${e.message}`);

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

  private async handleConflict(pull: any, error: Error) {
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
      const currentLabels = prData.labels
        .map((l: any) => l.name)
        .filter(Boolean);

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
          `This pull request has a merge conflict with the base branch! Please resolve the conflict manually.`,
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
  async performUpdate(pull: any): Promise<void> {
    const mergeMsg = this.config.mergeMsg();
    const mergeOpts: MergeParameters = {
      owner: pull.head.repo.owner.login,
      repo: pull.head.repo.name,
      base: pull.head.ref,
      head: pull.base.ref,
    };

    if (mergeMsg) mergeOpts.commit_message = mergeMsg;

    const mergeResp = await this.github.mergeBranch(mergeOpts);
    if (mergeResp.status === 200 || mergeResp.status === 201) {
      ghCore.info(`Branch update successful, new HEAD: ${mergeResp.data.sha}.`);
    } else if (mergeResp.status === 204) {
      ghCore.info('Branch update not required, branch is already up-to-date.');
    }
  }
}

export class RebaseUpdateStrategy extends BaseUpdateStrategy {
  async performUpdate(pull: any): Promise<void> {
    // Note: Node ID must exist on the GraphQL PullRequest object.
    await this.github.rebaseBranch(pull.node_id);
    ghCore.info(`Branch update successful via rebase.`);
  }
}
