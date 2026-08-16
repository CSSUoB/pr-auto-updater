import * as ghCore from '@actions/core';
import { ConfigLoader } from '../config-loader';
import { GitHubService } from '../services/GitHubService';

export class PullRequestEvaluator {
  constructor(
    private config: ConfigLoader,
    private github: GitHubService,
  ) {}

  async prNeedsUpdate(pull: any): Promise<boolean> {
    if (pull.merged === true) {
      ghCore.warning('Skipping pull request, already merged.');
      return false;
    }
    if (pull.state !== 'open') {
      ghCore.warning(
        `Skipping pull request, no longer open (current state: ${pull.state}).`,
      );
      return false;
    }
    if (!pull.head.repo) {
      ghCore.warning(
        `Skipping pull request, fork appears to have been deleted.`,
      );
      return false;
    }

    if (
      pull.base?.repo?.full_name &&
      pull.head.repo.full_name !== pull.base.repo.full_name
    ) {
      ghCore.info('Pull request is from a fork, skipping...');
      return false;
    }

    try {
      const { data: comparison } = await this.github.compareCommits(
        pull.head.repo.owner.login,
        pull.head.repo.name,
        `${pull.head.label}...${pull.base.label}`,
      );

      if (comparison.behind_by === 0) {
        ghCore.info('Skipping pull request, up-to-date with base branch.');
        return false;
      }
    } catch (e: any) {
      ghCore.error(
        `Caught error trying to compare base with head: ${e.message}`,
      );
      return false;
    }

    const excludedLabels = this.config.excludedLabels();
    if (excludedLabels.length > 0) {
      for (const label of pull.labels) {
        if (label.name && excludedLabels.includes(label.name)) {
          ghCore.info(
            `Pull request has excluded label '${label.name}', skipping update.`,
          );
          return false;
        }
      }
    }

    const readyStateFilter = this.config.pullRequestReadyState();
    if (readyStateFilter !== 'all') {
      if (readyStateFilter === 'draft' && !pull.draft) {
        ghCore.info(
          'PR_READY_STATE=draft and pull request is not draft, skipping.',
        );
        return false;
      }
      if (readyStateFilter === 'ready_for_review' && pull.draft) {
        ghCore.info(
          'PR_READY_STATE=ready_for_review and pull request is draft, skipping.',
        );
        return false;
      }
    }

    const prFilter = this.config.pullRequestFilter();

    if (prFilter === 'labelled') {
      const labels = this.config.pullRequestLabels();
      if (labels.length === 0) return false;

      for (const label of pull.labels) {
        if (label.name && labels.includes(label.name)) {
          return true;
        }
      }
      return false;
    }

    if (prFilter === 'protected') {
      const { data: branch } = await this.github.getBranch(
        pull.head.repo.owner.login,
        pull.head.repo.name,
        pull.base.ref,
      );
      return branch.protected;
    }

    if (prFilter === 'auto_merge') {
      return pull.auto_merge !== null;
    }

    return true;
  }
}
