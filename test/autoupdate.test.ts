// Workaround for tests attempting to hit the GH API if running in an env where
// this variable is automatically set.
if ('GITHUB_TOKEN' in process.env) {
  delete process.env.GITHUB_TOKEN;
}

import nock from 'nock';
import config from '../src/config-loader';
import { AutoUpdater } from '../src/autoupdater';
import type { Endpoints } from '@octokit/types';
import type {
  PullRequestEvent,
  PushEvent,
  WebhookEvent,
  WorkflowDispatchEvent,
  WorkflowRunEvent,
} from '@octokit/webhooks-types/schema';
import * as core from '@actions/core';
import { Output } from '../src/Output';
import * as isRequestErrorModule from '../src/helpers/isRequestError';
import {
  MergeUpdateStrategy,
  RebaseUpdateStrategy,
} from '../src/strategies/UpdateStrategy';

type PullRequestResponse =
  Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response'];

jest.mock('../src/config-loader');

beforeEach(() => {
  jest.resetAllMocks();
  (config.githubToken as jest.Mock).mockReturnValue('test-token');
  (config.updateMethod as jest.Mock).mockReturnValue('merge'); // Default to merge for legacy tests
});

// `resetAllMocks` blanks a spy's implementation rather than restoring it, so
// without this a spied-on module function (e.g. `isRequestError`) would return
// undefined for every subsequent test in the file.
afterEach(() => {
  jest.restoreAllMocks();
  nock.cleanAll();
});

const emptyEvent = {} as WebhookEvent;
const owner = 'chinthakagodawita';
const repo = 'not-a-real-repo';
const base = 'master';
const head = 'develop';
const branch = 'not-a-real-branch';

const dummyPushEvent: PushEvent = {
  ref: `refs/heads/${branch}`,
  repository: {
    owner: {
      login: owner,
    },
    name: repo,
  },
} as any;
const dummyWorkflowDispatchEvent: WorkflowDispatchEvent = {
  ref: `refs/heads/${branch}`,
  repository: {
    owner: { login: owner },
    name: repo,
  },
} as any;
const dummyWorkflowRunPushEvent: WorkflowRunEvent = {
  workflow_run: {
    event: 'push',
    head_branch: branch,
  },
  repository: {
    owner: { name: owner },
    name: repo,
  },
} as any;
const dummyWorkflowRunPullRequestEvent: WorkflowRunEvent = {
  workflow_run: {
    event: 'pull_request',
    head_branch: branch,
  },
  repository: {
    owner: { name: owner },
    name: repo,
  },
} as any;
const dummyScheduleEvent = {
  schedule: '*/5 * * * *',
};
const invalidLabelPull = {
  number: 1,
  merged: false,
  state: 'open',
  labels: [
    {
      id: 1,
    },
  ],
  base: {
    ref: base,
    label: base,
  },
  head: {
    label: head,
    ref: head,
    repo: {
      name: repo,
      owner: {
        login: owner,
      },
    },
  },
};
const validPull = {
  number: 1,
  merged: false,
  state: 'open',
  labels: [
    { id: 1, name: 'one' },
    { id: 2, name: 'two' },
  ],
  base: {
    ref: base,
    label: base,
    sha: 'base-sha',
    repo: {
      name: repo,
      owner: { login: owner },
    },
  },
  head: {
    label: head,
    ref: head,
    sha: 'head-sha',
    repo: {
      name: repo,
      owner: { login: owner },
    },
  },
  draft: false,
  auto_merge: null,
};
const clonePull = () => JSON.parse(JSON.stringify(validPull));

// Helper mock pull for merge/conflict tests
const mergeTestPull = {
  number: 1,
  head: {
    ref: head,
    repo: { name: repo, owner: { login: owner } },
  },
  base: { ref: base },
};

describe('test `prNeedsUpdate`', () => {
  test('pull request is from a fork', async () => {
    const pull = clonePull();
    pull.base.repo = {
      ...pull.base.repo,
      full_name: `${owner}/${repo}`,
    } as any;
    pull.head.repo = {
      ...pull.head.repo,
      full_name: 'someone-else/forked-repo',
    } as any;

    const updater = new AutoUpdater(config, emptyEvent);
    const compareSpy = jest.spyOn(
      updater.github.rest.repos,
      'compareCommitsWithBasehead',
    );

    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(compareSpy).not.toHaveBeenCalled();
  });

  test('pull request is not from a fork and compare request is made', async () => {
    const pull = clonePull();
    pull.base.repo = {
      ...pull.base.repo,
      full_name: `${owner}/${repo}`,
    } as any;
    pull.head.repo = {
      ...pull.head.repo,
      full_name: `${owner}/${repo}`,
    } as any;

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 0 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request has already been merged', async () => {
    const pull = { merged: true };
    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('pull request is not open', async () => {
    const pull = { merged: false, state: 'closed' };
    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('originating repo of pull request has been deleted', async () => {
    const pull = Object.assign({}, validPull, {
      head: { label: head, ref: head, repo: null },
    });
    const updater = new AutoUpdater(config, {} as WebhookEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('pull request is not behind', async () => {
    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 0 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
  });

  test('excluded labels were configured but not found', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.excludedLabels as jest.Mock).mockReturnValue(['label']);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('excluded labels exist', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.pullRequestLabels as jest.Mock).mockReturnValue([]);
    (config.excludedLabels as jest.Mock).mockReturnValue(['dependencies']);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [
      { id: 3, name: 'autoupdate' },
      { id: 4, name: 'dependencies' },
    ];
    const needsUpdate = await updater.evaluator.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.excludedLabels).toHaveBeenCalled();
    expect(config.pullRequestFilter).toHaveBeenCalledTimes(0);
    expect(config.pullRequestLabels).toHaveBeenCalledTimes(0);
  });

  test('no pull request labels were configured', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue([]);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.pullRequestLabels).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request has no labels', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['one', 'two']);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [];
    const needsUpdate = await updater.evaluator.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.pullRequestLabels).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request has labels with no name', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['one', 'two']);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      invalidLabelPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.pullRequestLabels).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request labels do match', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['three', 'four']);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [{ id: 3, name: 'three' }];
    const needsUpdate = await updater.evaluator.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(true);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request is against protected branch', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('protected');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const getBranch = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/branches/${base}`)
      .reply(200, { protected: true });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(comparePr.isDone()).toEqual(true);
    expect(getBranch.isDone()).toEqual(true);
  });

  test('no filters configured', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 1 });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(comparePr.isDone()).toEqual(true);
  });

  describe('pull request ready state filtering', () => {
    const readyPull = clonePull();
    const draftPull = Object.assign(clonePull(), { draft: true });

    const nockCompareRequest = () =>
      nock('https://api.github.com:443')
        .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
        .reply(200, { behind_by: 1 });

    beforeEach(() => {
      (config.excludedLabels as jest.Mock).mockReturnValue([]);
    });

    test('pull request ready state is not filtered', async () => {
      (config.pullRequestReadyState as jest.Mock).mockReturnValue('all');
      const readyScope = nockCompareRequest();
      const draftScope = nockCompareRequest();
      const updater = new AutoUpdater(config, emptyEvent);

      const readyPullNeedsUpdate =
        await updater.evaluator.prNeedsUpdate(readyPull);
      const draftPullNeedsUpdate =
        await updater.evaluator.prNeedsUpdate(draftPull);

      expect(readyPullNeedsUpdate).toEqual(true);
      expect(draftPullNeedsUpdate).toEqual(true);
      expect(readyScope.isDone()).toEqual(true);
      expect(draftScope.isDone()).toEqual(true);
    });

    test('pull request is filtered to drafts only', async () => {
      (config.pullRequestReadyState as jest.Mock).mockReturnValue('draft');
      const readyScope = nockCompareRequest();
      const draftScope = nockCompareRequest();
      const updater = new AutoUpdater(config, emptyEvent);

      const readyPullNeedsUpdate =
        await updater.evaluator.prNeedsUpdate(readyPull);
      const draftPullNeedsUpdate =
        await updater.evaluator.prNeedsUpdate(draftPull);

      expect(readyPullNeedsUpdate).toEqual(false);
      expect(draftPullNeedsUpdate).toEqual(true);

      expect(readyScope.isDone()).toEqual(true);
      expect(draftScope.isDone()).toEqual(true);
    });
  });
});

describe('test `handlePush`', () => {
  const cloneEvent = () => JSON.parse(JSON.stringify(dummyPushEvent));

  test('push event on a non-branch', async () => {
    const event = cloneEvent();
    event.ref = 'not-a-branch';
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handlePush();
    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });

  test('push event on a branch with PRs', async () => {
    const updater = new AutoUpdater(config, dummyPushEvent);
    const pullsMock: any[] = [
      { id: 0, number: 0 },
      { id: 1, number: 1 },
    ];
    const expectedPulls = 2;

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handlePush();
    expect(updated).toEqual(expectedPulls);
    expect(updateSpy).toHaveBeenCalledTimes(expectedPulls);
    expect(scope.isDone()).toEqual(true);
  });
});

describe('test `handleSchedule`', () => {
  test('schedule event on a branch with PRs', async () => {
    (config.githubRef as jest.Mock).mockReturnValue(`refs/heads/${base}`);
    (config.githubRepository as jest.Mock).mockReturnValue(`${owner}/${repo}`);

    const updater = new AutoUpdater(
      config,
      dummyScheduleEvent as unknown as WebhookEvent,
    );
    const pullsMock: any[] = [{ id: 0, number: 0 }];
    const expectedPulls = 1;

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${base}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleSchedule();
    expect(updated).toEqual(expectedPulls);
    expect(scope.isDone()).toEqual(true);
    expect(updateSpy).toHaveBeenCalled();
  });
});

describe('test `update`', () => {
  test('when a pull request does not need an update', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest
      .spyOn(updater.evaluator, 'prNeedsUpdate')
      .mockResolvedValue(false);
    const needsUpdate = await updater.update(owner, <any>validPull);
    expect(needsUpdate).toEqual(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalled();
  });

  test('dry run mode', async () => {
    (config.dryRun as jest.Mock).mockReturnValue(true);
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest
      .spyOn(updater.evaluator, 'prNeedsUpdate')
      .mockResolvedValue(true);
    const strategySpy = jest.spyOn(updater.strategy, 'execute');

    const needsUpdate = await updater.update(owner, <any>validPull);
    expect(needsUpdate).toEqual(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(strategySpy).toHaveBeenCalledTimes(0);
  });

  test('custom merge message', async () => {
    const mergeMsg = 'dummy-merge-msg';
    (config.mergeMsg as jest.Mock).mockReturnValue(mergeMsg);
    const updater = new AutoUpdater(config, emptyEvent);

    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    const mergeApiSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockResolvedValue({ status: 200, data: { sha: '123' } } as any);

    const needsUpdate = await updater.update(owner, <any>validPull);

    expect(needsUpdate).toEqual(true);
    expect(mergeApiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: validPull.head.repo.owner.login,
        repo: validPull.head.repo.name,
        commit_message: mergeMsg,
        base: validPull.head.ref,
        head: validPull.base.ref,
      }),
    );
  });

  test('update: reports a non-Error thrown by the strategy', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    jest.spyOn(updater.strategy, 'execute').mockRejectedValue('a string throw');

    const setFailedSpy = jest
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {});
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});

    const result = await updater.update(owner, <any>validPull);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Caught error running update: a string throw',
    );
    expect(setFailedSpy).toHaveBeenCalledWith('a string throw');
  });

  test('update: logs and sets failed if strategy execute throws', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    const mergeError = new Error('update failed');
    jest.spyOn(updater.strategy, 'execute').mockRejectedValue(mergeError);

    const setFailedSpy = jest
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {});
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});

    const result = await updater.update(owner, <any>validPull);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Caught error running update: update failed',
    );
    expect(setFailedSpy).toHaveBeenCalledWith(mergeError);

    setFailedSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('MergeUpdateStrategy conflict and retry logic', () => {
  test('doMerge: logs info and returns true if status is 204', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeMock = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockResolvedValue({ status: 204, data: {} } as any);
    (config.retryCount as jest.Mock).mockReturnValue(0);
    (config.retrySleep as jest.Mock).mockReturnValue(1);

    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Branch update not required, branch is already up-to-date.',
    );
    expect(mergeMock).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  test('mergeConflictAction label, label not present, adds label and comment', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    (config.mergeConflictAction as jest.Mock).mockReturnValue('label');
    (config.mergeConflictLabel as jest.Mock).mockReturnValue('conflict');

    jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Merge conflict'));
    jest
      .spyOn(updater.github, 'getPullRequest')
      .mockResolvedValue({ data: { labels: [{ name: 'foo' }] } } as any);
    const issuesUpdate = jest
      .spyOn(updater.github, 'updateIssueLabels')
      .mockResolvedValue({} as any);
    const issuesComment = jest
      .spyOn(updater.github, 'createIssueComment')
      .mockResolvedValue({} as any);

    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(false);
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, true);
    expect(issuesUpdate).toHaveBeenCalled();
    expect(issuesComment).toHaveBeenCalled();
    setOutputSpy.mockRestore();
  });

  test('mergeConflictAction label, label already present, does not add label or comment', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    (config.mergeConflictAction as jest.Mock).mockReturnValue('label');
    (config.mergeConflictLabel as jest.Mock).mockReturnValue('conflict');

    jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Merge conflict'));
    jest
      .spyOn(updater.github, 'getPullRequest')
      .mockResolvedValue({ data: { labels: [{ name: 'conflict' }] } } as any);
    const updateSpy = jest.spyOn(updater.github, 'updateIssueLabels');
    const commentSpy = jest.spyOn(updater.github, 'createIssueComment');

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(commentSpy).not.toHaveBeenCalled();
  });

  test('mergeConflictAction fail, throws error and logs', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    (config.mergeConflictAction as jest.Mock).mockReturnValue('fail');

    jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Merge conflict'));
    (config.retryCount as jest.Mock).mockReturnValue(0);

    await expect(
      updater.strategy.execute(owner, mergeTestPull as any),
    ).rejects.toThrow('Merge conflict');
  });

  test('mergeConflictAction ignore, skips update and logs', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    (config.mergeConflictAction as jest.Mock).mockReturnValue('ignore');

    jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Merge conflict'));
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      'Merge conflict detected, skipping update.',
    );
    infoSpy.mockRestore();
  });
});

describe('MergeUpdateStrategy authorisation error handling', () => {
  test('handles missing token or opts.auth error', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error: Error & { status?: number } = new Error(
      'Parameter token or opts.auth is required',
    );
    error.status = 401;
    jest.spyOn(updater.github, 'mergeBranch').mockRejectedValue(error);
    jest.spyOn(isRequestErrorModule, 'isRequestError').mockReturnValue(true);
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, mergeTestPull as any);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Authorisation error: Parameter token or opts.auth is required',
      ),
    );
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(result).toBe(false);
    errorSpy.mockRestore();
    setOutputSpy.mockRestore();
  });
});

describe('test `handlePullRequest`', () => {
  test('pull request event with an update triggered', async () => {
    const event = { pull_request: clonePull() } as PullRequestEvent;
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handlePullRequest();

    expect(updated).toEqual(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  test('pull request event without an update', async () => {
    const event = { pull_request: clonePull() } as PullRequestEvent;
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(false);

    const updated = await updater.handlePullRequest();

    expect(updated).toEqual(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  test('pull request head repo is null', async () => {
    const event = {
      action: 'synchronize',
      pull_request: { head: { repo: null } },
    } as any;
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handlePullRequest();

    expect(updated).toEqual(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('test `handleWorkflowDispatch`', () => {
  test('workflow dispatch event on a branch with PRs', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowDispatchEvent);
    const pullsMock = [
      { id: 0, number: 0 },
      { id: 1, number: 1 },
    ];

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleWorkflowDispatch();

    expect(updated).toEqual(2);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(scope.isDone()).toEqual(true);
  });
});

describe('test `handleWorkflowRun`', () => {
  const cloneEvent = () =>
    JSON.parse(JSON.stringify(dummyWorkflowRunPushEvent));

  test('workflow_run event by push event on a non-branch', async () => {
    const event = cloneEvent();
    event.workflow_run.head_branch = '';
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('workflow_run event with an unsupported event type', async () => {
    const event = cloneEvent();
    event.workflow_run.event = 'pull_request_review';
    const updater = new AutoUpdater(config, event);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('workflow_run event by push event on a branch without any PRs', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowRunPushEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, []);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by push event on a branch with PRs', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowRunPushEvent);
    const pullsMock = [
      { id: 0, number: 0 },
      { id: 1, number: 1 },
    ];
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(2);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by pull_request event with an update triggered', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowRunPullRequestEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, [{ id: 0, number: 0 }]);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by pull_request event without an update', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowRunPullRequestEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(false);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, [{ id: 0, number: 0 }]);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(scope.isDone()).toEqual(true);
  });
});

describe('test `handleSchedule` edge cases', () => {
  test('schedule event with undefined GITHUB_REPOSITORY env var', async () => {
    (config.githubRef as jest.Mock).mockReturnValue(`refs/heads/${base}`);
    (config.githubRepository as jest.Mock).mockImplementation(() => {
      throw new Error('Environment variable was not provided');
    });

    const updater = new AutoUpdater(
      config,
      dummyScheduleEvent as unknown as WebhookEvent,
    );

    await expect(updater.handleSchedule()).rejects.toThrow();
  });

  test('schedule event with undefined GITHUB_REF env var', async () => {
    (config.githubRepository as jest.Mock).mockReturnValue(`${owner}/${repo}`);
    (config.githubRef as jest.Mock).mockImplementation(() => {
      throw new Error('Environment variable was not provided');
    });

    const updater = new AutoUpdater(
      config,
      dummyScheduleEvent as unknown as WebhookEvent,
    );

    await expect(updater.handleSchedule()).rejects.toThrow();
  });

  test('schedule event with invalid GITHUB_REPOSITORY env var', async () => {
    (config.githubRef as jest.Mock).mockReturnValue(`refs/heads/${base}`);
    (config.githubRepository as jest.Mock).mockReturnValue('');

    const updater = new AutoUpdater(
      config,
      dummyScheduleEvent as unknown as WebhookEvent,
    );
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handleSchedule();

    expect(updated).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('test `pulls` guard clauses', () => {
  test('push event on a branch without any PRs', async () => {
    const updater = new AutoUpdater(config, dummyPushEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);
    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, []);

    const updated = await updater.handlePush();

    expect(updated).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(scope.isDone()).toEqual(true);
  });

  test('returns 0 if the owner is missing', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const result = await updater.pulls(
      'refs/heads/main',
      repo,
      undefined as any,
      undefined as any,
    );

    expect(result).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('returns 0 if the repo name is missing', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const result = await updater.pulls(
      'refs/heads/main',
      undefined as any,
      owner,
      owner,
    );

    expect(result).toEqual(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('`prNeedsUpdate` additional filters', () => {
  const nockCompare = (behindBy = 1) =>
    nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: behindBy });

  beforeEach(() => {
    (config.excludedLabels as jest.Mock).mockReturnValue([]);
    (config.pullRequestReadyState as jest.Mock).mockReturnValue('all');
  });

  test('returns false and logs if the compare request throws', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest
      .spyOn(updater.github, 'compareCommits')
      .mockRejectedValue(new Error('compare error'));
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});

    const needsUpdate = await updater.evaluator.prNeedsUpdate(clonePull());

    expect(needsUpdate).toEqual(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Caught error trying to compare base with head: compare error',
    );
    errorSpy.mockRestore();
  });

  test('pull request labels do not match', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['three', 'four']);
    const scope = nockCompare();

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(clonePull());

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
  });

  test('excluded labels are checked even when a label has no name', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.excludedLabels as jest.Mock).mockReturnValue(['excluded']);
    const scope = nockCompare();

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(
      invalidLabelPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request is not against a protected branch', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('protected');
    const comparePr = nockCompare();
    const getBranch = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/branches/${base}`)
      .reply(200, { protected: false });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(clonePull());

    expect(needsUpdate).toEqual(false);
    expect(comparePr.isDone()).toEqual(true);
    expect(getBranch.isDone()).toEqual(true);
  });

  test('pull request has auto_merge enabled', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('auto_merge');
    const scope = nockCompare();
    const pull = clonePull();
    pull.auto_merge = { merge_method: 'merge' };

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(true);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request does not have auto_merge enabled', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('auto_merge');
    const scope = nockCompare();

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.evaluator.prNeedsUpdate(clonePull());

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request ready state is filtered to ready PRs only', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.pullRequestReadyState as jest.Mock).mockReturnValue(
      'ready_for_review',
    );
    const readyScope = nockCompare();
    const draftScope = nockCompare();
    const draftPull = Object.assign(clonePull(), { draft: true });

    const updater = new AutoUpdater(config, emptyEvent);

    expect(await updater.evaluator.prNeedsUpdate(clonePull())).toEqual(true);
    expect(await updater.evaluator.prNeedsUpdate(draftPull)).toEqual(false);
    expect(readyScope.isDone()).toEqual(true);
    expect(draftScope.isDone()).toEqual(true);
  });
});

describe('`update` additional cases', () => {
  test('pull request without a head repository', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    const strategySpy = jest.spyOn(updater.strategy, 'execute');
    const pull = { ...validPull, head: { ...validPull.head, repo: null } };

    const needsUpdate = await updater.update(owner, <any>pull);

    expect(needsUpdate).toEqual(false);
    expect(strategySpy).not.toHaveBeenCalled();
  });

  test('merge with no message omits commit_message', async () => {
    (config.mergeMsg as jest.Mock).mockReturnValue('');
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    const mergeApiSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockResolvedValue({ status: 201, data: { sha: '123' } } as any);

    const needsUpdate = await updater.update(owner, <any>validPull);

    expect(needsUpdate).toEqual(true);
    expect(mergeApiSpy).toHaveBeenCalledWith({
      owner: validPull.head.repo.owner.login,
      repo: validPull.head.repo.name,
      base: validPull.head.ref,
      head: validPull.base.ref,
    });
  });
});

describe('MergeUpdateStrategy retry logic', () => {
  beforeEach(() => {
    (config.retrySleep as jest.Mock).mockReturnValue(1);
  });

  test('retries a transient failure and then succeeds', async () => {
    (config.retryCount as jest.Mock).mockReturnValue(1);
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValueOnce(new Error('Temporary error'))
      .mockResolvedValueOnce({ status: 201, data: { sha: 'abc' } } as any);

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
  });

  test('retries up to the configured maximum', async () => {
    (config.retryCount as jest.Mock).mockReturnValue(3);
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Always fails'));

    await expect(
      updater.strategy.execute(owner, mergeTestPull as any),
    ).rejects.toThrow('Always fails');

    // Initial attempt plus three retries.
    expect(mergeSpy).toHaveBeenCalledTimes(4);
  });

  test('throws immediately when retries are disabled', async () => {
    (config.retryCount as jest.Mock).mockReturnValue(0);
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Always fails'));
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});

    await expect(
      updater.strategy.execute(owner, mergeTestPull as any),
    ).rejects.toThrow('Always fails');

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, false);
  });
});

describe('update strategy error classification', () => {
  beforeEach(() => {
    (config.retrySleep as jest.Mock).mockReturnValue(1);
    (config.retryCount as jest.Mock).mockReturnValue(3);
  });

  test('returns false without retrying on a 403 from a fork', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error: Error & { status?: number } = new Error('Forbidden');
    error.status = 403;
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(error);
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});

    const result = await updater.strategy.execute(
      'a-different-owner',
      mergeTestPull as any,
    );

    expect(result).toBe(false);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(errorSpy).toHaveBeenCalledWith('Fork write access error: Forbidden');
  });

  test('retries a 403 when the pull request is not from a fork', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error: Error & { status?: number } = new Error('Forbidden');
    error.status = 403;
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 201, data: { sha: 'abc' } } as any);

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
  });

  // Regression test: matching any error mentioning 'conflict' would misclassify
  // unrelated failures, skipping the retry logic and mislabelling the PR.
  test('an unrelated error mentioning "conflict" is retried, not labelled', async () => {
    (config.mergeConflictAction as jest.Mock).mockReturnValue('label');
    (config.mergeConflictLabel as jest.Mock).mockReturnValue('conflict');
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValueOnce(new Error('Scheduling conflict with another job'))
      .mockResolvedValueOnce({ status: 201, data: { sha: 'abc' } } as any);
    const labelSpy = jest.spyOn(updater.github, 'updateIssueLabels');
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect(labelSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).not.toHaveBeenCalledWith(Output.Conflicted, true);
  });

  test('a GraphQL error entry without a message is not a conflict', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('Request failed');
    (error as any).errors = [{ type: 'INTERNAL' }];
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 201, data: { sha: 'abc' } } as any);

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
  });

  test('a thrown value with no message is not a conflict', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeSpy = jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValueOnce({})
      .mockResolvedValueOnce({ status: 201, data: { sha: 'abc' } } as any);

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(true);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
  });

  test('conflict labelling removes the configured filter labels', async () => {
    (config.mergeConflictAction as jest.Mock).mockReturnValue('label');
    (config.mergeConflictLabel as jest.Mock).mockReturnValue('conflict');
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['foo', 'bar']);

    const updater = new AutoUpdater(config, emptyEvent);
    jest
      .spyOn(updater.github, 'mergeBranch')
      .mockRejectedValue(new Error('Merge conflict'));
    jest.spyOn(updater.github, 'getPullRequest').mockResolvedValue({
      data: { labels: [{ name: 'foo' }, { name: 'baz' }] },
    } as any);
    const issuesUpdate = jest
      .spyOn(updater.github, 'updateIssueLabels')
      .mockResolvedValue({} as any);
    const issuesComment = jest
      .spyOn(updater.github, 'createIssueComment')
      .mockResolvedValue({} as any);

    const result = await updater.strategy.execute(owner, mergeTestPull as any);

    expect(result).toBe(false);
    // 'foo' is a filter label and is dropped; 'baz' is unrelated and kept.
    expect(issuesUpdate).toHaveBeenCalledWith(owner, repo, 1, [
      'baz',
      'conflict',
    ]);
    expect(issuesComment).toHaveBeenCalled();
  });
});

describe('RebaseUpdateStrategy', () => {
  const rebasePull = { ...mergeTestPull, node_id: 'PR_node_1' };

  const rebaseUpdater = () => {
    (config.updateMethod as jest.Mock).mockReturnValue('rebase');
    return new AutoUpdater(config, emptyEvent);
  };

  // Mirrors @octokit/graphql's GraphqlResponseError: the GraphQL API replies
  // with HTTP 200 and an `errors` array, so these carry no `status` and are
  // invisible to REST-shaped error handling.
  const graphqlError = (errors: Array<{ type?: string; message: string }>) => {
    const error = new Error(
      `Request failed due to following response errors:\n${errors
        .map((e) => ` - ${e.message}`)
        .join('\n')}`,
    );
    (error as any).errors = errors;
    return error;
  };

  beforeEach(() => {
    (config.retrySleep as jest.Mock).mockReturnValue(1);
    (config.retryCount as jest.Mock).mockReturnValue(3);
  });

  test('is selected when UPDATE_METHOD is rebase', () => {
    const updater = rebaseUpdater();

    expect(updater.strategy).toBeInstanceOf(RebaseUpdateStrategy);
    expect(updater.strategy.name).toEqual('rebase');
  });

  test('merge remains the default strategy', () => {
    const updater = new AutoUpdater(config, emptyEvent);

    expect(updater.strategy).toBeInstanceOf(MergeUpdateStrategy);
    expect(updater.strategy.name).toEqual('merge');
  });

  test('rebases using the pull request node ID', async () => {
    const updater = rebaseUpdater();
    const rebaseSpy = jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockResolvedValue({} as any);
    const mergeSpy = jest.spyOn(updater.github, 'mergeBranch');
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, rebasePull as any);

    expect(result).toBe(true);
    expect(rebaseSpy).toHaveBeenCalledWith('PR_node_1');
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(infoSpy).toHaveBeenCalledWith(
      'Branch update successful via rebase.',
    );
  });

  test('fails with a clear message when the pull request has no node ID', async () => {
    (config.retryCount as jest.Mock).mockReturnValue(0);
    const updater = rebaseUpdater();
    const rebaseSpy = jest.spyOn(updater.github, 'rebaseBranch');

    await expect(
      updater.strategy.execute(owner, mergeTestPull as any),
    ).rejects.toThrow('Cannot rebase pull request #1, it has no node ID.');

    expect(rebaseSpy).not.toHaveBeenCalled();
  });

  test('treats a GraphQL conflict error as a merge conflict', async () => {
    (config.mergeConflictAction as jest.Mock).mockReturnValue('ignore');
    const updater = rebaseUpdater();
    const rebaseSpy = jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockRejectedValue(
        graphqlError([
          {
            type: 'UNPROCESSABLE',
            message: 'merge conflict between base and head',
          },
        ]),
      );
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});

    const result = await updater.strategy.execute(owner, rebasePull as any);

    expect(result).toBe(false);
    // A conflict must not be retried.
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Merge conflict detected, skipping update.',
    );
  });

  test('labels a conflicted pull request when configured to', async () => {
    (config.mergeConflictAction as jest.Mock).mockReturnValue('label');
    (config.mergeConflictLabel as jest.Mock).mockReturnValue('conflict');
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    const updater = rebaseUpdater();
    jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockRejectedValue(
        graphqlError([
          { type: 'UNPROCESSABLE', message: 'has conflicts with the base' },
        ]),
      );
    jest
      .spyOn(updater.github, 'getPullRequest')
      .mockResolvedValue({ data: { labels: [{ name: 'foo' }] } } as any);
    const issuesUpdate = jest
      .spyOn(updater.github, 'updateIssueLabels')
      .mockResolvedValue({} as any);
    const issuesComment = jest
      .spyOn(updater.github, 'createIssueComment')
      .mockResolvedValue({} as any);

    const result = await updater.strategy.execute(owner, rebasePull as any);

    expect(result).toBe(false);
    expect(issuesUpdate).toHaveBeenCalledWith(owner, repo, 1, [
      'foo',
      'conflict',
    ]);
    expect(issuesComment).toHaveBeenCalled();
  });

  // Regression test: a GraphQL error carries no `status`, so the REST-only
  // permission check never matched it. A fork permission failure used to burn
  // every retry and then fail the whole action.
  test('returns false without retrying on a GraphQL FORBIDDEN error from a fork', async () => {
    const updater = rebaseUpdater();
    const rebaseSpy = jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockRejectedValue(
        graphqlError([
          {
            type: 'FORBIDDEN',
            message: 'must have write access to the repository',
          },
        ]),
      );
    const setOutputSpy = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => {});
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});

    const result = await updater.strategy.execute(
      'a-different-owner',
      rebasePull as any,
    );

    expect(result).toBe(false);
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
    expect(setOutputSpy).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fork write access error'),
    );
  });

  test('treats a GraphQL UNAUTHORIZED error from a fork the same way', async () => {
    const updater = rebaseUpdater();
    const rebaseSpy = jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockRejectedValue(
        graphqlError([{ type: 'UNAUTHORIZED', message: 'not authorised' }]),
      );
    jest.spyOn(core, 'setOutput').mockImplementation(() => {});
    jest.spyOn(core, 'error').mockImplementation(() => {});

    const result = await updater.strategy.execute(
      'a-different-owner',
      rebasePull as any,
    );

    expect(result).toBe(false);
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
  });

  test('retries a transient GraphQL error and then succeeds', async () => {
    const updater = rebaseUpdater();
    const rebaseSpy = jest
      .spyOn(updater.github, 'rebaseBranch')
      .mockRejectedValueOnce(
        graphqlError([{ type: 'INTERNAL', message: 'something went wrong' }]),
      )
      .mockResolvedValueOnce({} as any);

    const result = await updater.strategy.execute(owner, rebasePull as any);

    expect(result).toBe(true);
    expect(rebaseSpy).toHaveBeenCalledTimes(2);
  });

  test('update() dry run reports the rebase strategy without calling it', async () => {
    (config.dryRun as jest.Mock).mockReturnValue(true);
    const updater = rebaseUpdater();
    jest.spyOn(updater.evaluator, 'prNeedsUpdate').mockResolvedValue(true);
    const rebaseSpy = jest.spyOn(updater.github, 'rebaseBranch');
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});

    const result = await updater.update(owner, <any>validPull);

    expect(result).toEqual(true);
    expect(rebaseSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('via rebase'),
    );
  });
});
