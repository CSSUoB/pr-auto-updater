import * as ghCore from '@actions/core';
import type {
  WebhookEvent,
  PullRequestEvent,
  PushEvent,
  WorkflowRunEvent,
  WorkflowDispatchEvent,
} from '@octokit/webhooks-types/schema';
import { ConfigLoader } from './config-loader';
import { GitHubService } from './services/GitHubService';
import { PullRequestEvaluator } from './evaluators/PullRequestEvaluator';
import {
  UpdateStrategy,
  MergeUpdateStrategy,
  RebaseUpdateStrategy,
} from './strategies/UpdateStrategy';

export class AutoUpdater {
  eventData: WebhookEvent;
  config: ConfigLoader;
  github: GitHubService;
  evaluator: PullRequestEvaluator;
  strategy: UpdateStrategy;

  constructor(config: ConfigLoader, eventData: WebhookEvent) {
    this.eventData = eventData;
    this.config = config;
    this.github = new GitHubService(this.config.githubToken());
    this.evaluator = new PullRequestEvaluator(this.config, this.github);

    if (this.config.updateMethod() === 'rebase') {
      this.strategy = new RebaseUpdateStrategy(this.config, this.github);
    } else {
      this.strategy = new MergeUpdateStrategy(this.config, this.github);
    }
  }

  async handlePush(): Promise<number> {
    const { ref, repository } = this.eventData as PushEvent;
    return await this.pulls(
      ref,
      repository.name,
      repository.owner.login,
      repository.owner.name,
    );
  }

  async handlePullRequest(): Promise<boolean> {
    const { pull_request } = this.eventData as PullRequestEvent;
    if (!pull_request.head.repo) return false;

    return await this.update(pull_request.head.repo.owner.login, pull_request);
  }

  async handleSchedule(): Promise<number> {
    const ref = this.config.githubRef();
    const ownerAndRepo = this.config.githubRepository();
    const splitRepoName = ownerAndRepo.split('/');
    if (splitRepoName.length !== 2) return 0;

    return await this.pulls(ref, splitRepoName[1], splitRepoName[0]);
  }

  async handleWorkflowRun(): Promise<number> {
    const { workflow_run, repository } = this.eventData as WorkflowRunEvent;
    if (
      !['push', 'pull_request'].includes(workflow_run.event) ||
      !workflow_run.head_branch
    )
      return 0;

    return await this.pulls(
      `refs/heads/${workflow_run.head_branch}`,
      repository.name,
      repository.owner.login,
      repository.owner.name,
    );
  }

  async handleWorkflowDispatch(): Promise<number> {
    const { ref, repository } = this.eventData as WorkflowDispatchEvent;
    return await this.pulls(
      ref,
      repository.name,
      repository.owner.login,
      repository.owner.name,
    );
  }

  async pulls(
    ref: string,
    repoName: string,
    repoOwnerLogin: string,
    repoOwnerName?: string,
  ): Promise<number> {
    if (!ref.startsWith('refs/heads/')) return 0;

    const baseBranch = ref.replace('refs/heads/', '');
    const owner = repoOwnerName ?? repoOwnerLogin;
    if (!owner || !repoName) return 0;

    let updated = 0;
    const paginatorOpts = this.github.rest.pulls.list.endpoint.merge({
      owner,
      repo: repoName,
      base: baseBranch,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
    });

    for await (const pullsPage of this.github.paginate.iterator(
      paginatorOpts,
    )) {
      for (const pull of pullsPage.data) {
        ghCore.startGroup(`PR-${pull.number}`);
        const isUpdated = await this.update(owner, pull);
        ghCore.endGroup();
        if (isUpdated) updated++;
      }
    }
    return updated;
  }

  async update(sourceEventOwner: string, pull: any): Promise<boolean> {
    ghCore.info(`Evaluating pull request #${pull.number}...`);

    const prNeedsUpdate = await this.evaluator.prNeedsUpdate(pull);
    if (!prNeedsUpdate) return false;

    ghCore.info(
      `Updating branch '${pull.head.ref}' on pull request #${pull.number} with changes from ref '${pull.base.ref}'.`,
    );

    if (this.config.dryRun()) {
      ghCore.warning(
        `Would have merged ref '${pull.head.ref}' into ref '${pull.base.ref}' but DRY_RUN was enabled.`,
      );
      return true;
    }

    if (pull.head.repo === null) {
      ghCore.error(`Could not determine repository for this pull request.`);
      return false;
    }

    try {
      return await this.strategy.execute(sourceEventOwner, pull);
    } catch (e: any) {
      ghCore.error(`Caught error running update: ${e.message}`);
      ghCore.setFailed(e);
      return false;
    }
  }
}
