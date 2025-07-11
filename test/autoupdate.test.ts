// Workaround for tests attempting to hit the GH API if running in an env where
// this variable is automatically set.
if ('GITHUB_TOKEN' in process.env) {
  delete process.env.GITHUB_TOKEN;
}

import nock from 'nock';
import config from '../src/config-loader';
import { AutoUpdater } from '../src/autoupdater';
import { Endpoints } from '@octokit/types';
import {
  PullRequestEvent,
  PushEvent,
  WebhookEvent,
  WorkflowDispatchEvent,
  WorkflowRunEvent,
} from '@octokit/webhooks-types/schema';
import * as core from '@actions/core';
import { Output } from '../src/Output';
import * as isRequestErrorModule from '../src/helpers/isRequestError';

type PullRequestResponse =
  Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response'];

jest.mock('../src/config-loader');

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(config, 'githubToken').mockImplementation(() => 'test-token');
});

const emptyEvent = {} as WebhookEvent;
const owner = 'chinthakagodawita';
const repo = 'not-a-real-repo';
const base = 'master';
const head = 'develop';
const branch = 'not-a-real-branch';

// Replace problematic createMock usage with a manual mock for PushEvent
const dummyPushEvent: PushEvent = {
  ref: `refs/heads/${branch}`,
  repository: {
    owner: {
      login: owner,
    },
    name: repo,
  },
  // Add any other required PushEvent properties as needed for your tests
} as any;
const dummyWorkflowDispatchEvent: WorkflowDispatchEvent = {
  ref: `refs/heads/${branch}`,
  repository: {
    owner: {
      login: owner,
    },
    name: repo,
  },
} as any;
const dummyWorkflowRunPushEvent: WorkflowRunEvent = {
  workflow_run: {
    event: 'push',
    head_branch: branch,
  },
  repository: {
    owner: {
      name: owner,
    },
    name: repo,
  },
} as any;
const dummyWorkflowRunPullRequestEvent: WorkflowRunEvent = {
  workflow_run: {
    event: 'pull_request',
    head_branch: branch,
  },
  repository: {
    owner: {
      name: owner,
    },
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

describe('test `prNeedsUpdate`', () => {
  test('pull request has already been merged', async () => {
    const pull = {
      merged: true,
    };

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('pull request is not open', async () => {
    const pull = {
      merged: false,
      state: 'closed',
    };

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('originating repo of pull request has been deleted', async () => {
    const pull = Object.assign({}, validPull, {
      head: {
        label: head,
        ref: head,
        repo: null,
      },
    });
    const updater = new AutoUpdater(config, {} as WebhookEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      pull as unknown as PullRequestResponse['data'],
    );
    expect(needsUpdate).toEqual(false);
  });

  test('pull request is not behind', async () => {
    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 0,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
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
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
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
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [
      {
        id: 3,
        name: 'autoupdate',
      },
      {
        id: 4,
        name: 'dependencies',
      },
    ];
    const needsUpdate = await updater.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.excludedLabels).toHaveBeenCalled();

    // The excluded labels check happens before we check any filters so these
    // functions should never be called.
    expect(config.pullRequestFilter).toHaveBeenCalledTimes(0);
    expect(config.pullRequestLabels).toHaveBeenCalledTimes(0);
  });

  test('no pull request labels were configured', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue([]);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
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
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [];
    const needsUpdate = await updater.prNeedsUpdate(pull);

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
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      invalidLabelPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.pullRequestLabels).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request has labels with no name - excluded labels checked', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue([]);
    (config.excludedLabels as jest.Mock).mockReturnValue(['one', 'two']);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      invalidLabelPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(scope.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.pullRequestLabels).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request labels do not match', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('labelled');
    (config.pullRequestLabels as jest.Mock).mockReturnValue(['three', 'four']);
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const scope = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
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
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const pull = clonePull();
    pull.labels = [
      {
        id: 3,
        name: 'three',
      },
    ];
    const needsUpdate = await updater.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(true);
    expect(scope.isDone()).toEqual(true);
  });

  test('pull request is against protected branch', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('protected');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const getBranch = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/branches/${base}`)
      .reply(200, {
        protected: true,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(comparePr.isDone()).toEqual(true);
    expect(getBranch.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request is not against protected branch', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('protected');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const getBranch = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/branches/${base}`)
      .reply(200, {
        protected: false,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(false);
    expect(comparePr.isDone()).toEqual(true);
    expect(getBranch.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  test('pull request is against branch with auto_merge enabled', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('auto_merge');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);

    const pull = {
      ...validPull,
      auto_merge: {
        enabled: true,
        user: {
          login: 'chinthakagodawita',
        },
        merge_method: 'squash',
        commit_title: 'some-commit-title',
        commit_message: 'fixing a thing',
      },
    } as unknown as PullRequestResponse['data'];
    const needsUpdate = await updater.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(true);
    expect(comparePr.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
  });

  test('pull request is against branch with auto_merge disabled', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('auto_merge');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);

    const pull = {
      ...validPull,
      auto_merge: null,
    } as unknown as PullRequestResponse['data'];
    const needsUpdate = await updater.prNeedsUpdate(pull);

    expect(needsUpdate).toEqual(false);
    expect(comparePr.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
  });

  test('no filters configured', async () => {
    (config.pullRequestFilter as jest.Mock).mockReturnValue('all');
    (config.excludedLabels as jest.Mock).mockReturnValue([]);

    const comparePr = nock('https://api.github.com:443')
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, {
        behind_by: 1,
      });

    const updater = new AutoUpdater(config, emptyEvent);
    const needsUpdate = await updater.prNeedsUpdate(
      validPull as unknown as PullRequestResponse['data'],
    );

    expect(needsUpdate).toEqual(true);
    expect(comparePr.isDone()).toEqual(true);
    expect(config.pullRequestFilter).toHaveBeenCalled();
    expect(config.excludedLabels).toHaveBeenCalled();
  });

  describe('pull request ready state filtering', () => {
    const readyPull = clonePull();
    const draftPull = Object.assign(clonePull(), { draft: true });

    const nockCompareRequest = () =>
      nock('https://api.github.com:443')
        .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
        .reply(200, {
          behind_by: 1,
        });

    beforeEach(() => {
      (config.excludedLabels as jest.Mock).mockReturnValue([]);
    });

    test('pull request ready state is not filtered', async () => {
      (config.pullRequestReadyState as jest.Mock).mockReturnValue('all');

      const readyScope = nockCompareRequest();
      const draftScope = nockCompareRequest();

      const updater = new AutoUpdater(config, emptyEvent);

      const readyPullNeedsUpdate = await updater.prNeedsUpdate(readyPull);
      const draftPullNeedsUpdate = await updater.prNeedsUpdate(draftPull);

      expect(readyPullNeedsUpdate).toEqual(true);
      expect(draftPullNeedsUpdate).toEqual(true);
      expect(config.pullRequestReadyState).toHaveBeenCalled();
      expect(readyScope.isDone()).toEqual(true);
      expect(draftScope.isDone()).toEqual(true);
    });

    test('pull request is filtered to drafts only', async () => {
      (config.pullRequestReadyState as jest.Mock).mockReturnValue('draft');

      const readyScope = nockCompareRequest();
      const draftScope = nockCompareRequest();

      const updater = new AutoUpdater(config, emptyEvent);

      const readyPullNeedsUpdate = await updater.prNeedsUpdate(readyPull);
      const draftPullNeedsUpdate = await updater.prNeedsUpdate(draftPull);

      expect(readyPullNeedsUpdate).toEqual(false);
      expect(draftPullNeedsUpdate).toEqual(true);
      expect(config.pullRequestReadyState).toHaveBeenCalled();
      expect(readyScope.isDone()).toEqual(true);
      expect(draftScope.isDone()).toEqual(true);
    });

    test('pull request ready state is filtered to ready PRs only', async () => {
      (config.pullRequestReadyState as jest.Mock).mockReturnValue(
        'ready_for_review',
      );

      const readyScope = nockCompareRequest();
      const draftScope = nockCompareRequest();

      const updater = new AutoUpdater(config, emptyEvent);
      const readyPullNeedsUpdate = await updater.prNeedsUpdate(readyPull);
      const draftPullNeedsUpdate = await updater.prNeedsUpdate(draftPull);

      expect(readyPullNeedsUpdate).toEqual(true);
      expect(draftPullNeedsUpdate).toEqual(false);
      expect(config.pullRequestReadyState).toHaveBeenCalled();
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
    expect(updateSpy).toHaveBeenCalledTimes(0);
    expect(scope.isDone()).toEqual(true);
  });

  test('push event on a branch with PRs', async () => {
    const updater = new AutoUpdater(config, dummyPushEvent);

    const pullsMock: any[] = [];
    const expectedPulls = 5;
    for (let i = 0; i < expectedPulls; i++) {
      pullsMock.push({
        id: i,
        number: i,
      });
    }

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
    jest
      .spyOn(config, 'githubRef')
      .mockImplementation(() => `refs/heads/${base}`);

    jest
      .spyOn(config, 'githubRepository')
      .mockImplementation(() => `${owner}/${repo}`);

    const event = dummyScheduleEvent;
    const updater = new AutoUpdater(config, event as unknown as WebhookEvent);

    const pullsMock: any[] = [];
    const expectedPulls = 5;
    for (let i = 0; i < expectedPulls; i++) {
      pullsMock.push({
        id: i,
        number: i,
      });
    }

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${base}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleSchedule();

    expect(updated).toEqual(expectedPulls);
    expect(updateSpy).toHaveBeenCalledTimes(expectedPulls);
    expect(scope.isDone()).toEqual(true);
  });

  test('schedule event with undefined GITHUB_REPOSITORY env var', async () => {
    jest
      .spyOn(config, 'githubRef')
      .mockImplementation(() => `refs/heads/${base}`);

    const event = dummyScheduleEvent;
    const updater = new AutoUpdater(config, event as unknown as WebhookEvent);

    await expect(updater.handleSchedule()).rejects.toThrow();
  });

  test('schedule event with undefined GITHUB_REF env var', async () => {
    jest
      .spyOn(config, 'githubRepository')
      .mockImplementation(() => `${owner}/${repo}`);

    const event = dummyScheduleEvent;
    const updater = new AutoUpdater(config, event as unknown as WebhookEvent);
    await expect(updater.handleSchedule()).rejects.toThrow();
  });

  test('schedule event with invalid GITHUB_REPOSITORY env var', async () => {
    jest.spyOn(config, 'githubRepository').mockImplementation(() => '');
    jest
      .spyOn(config, 'githubRef')
      .mockImplementation(() => `refs/heads/${base}`);

    const event = dummyScheduleEvent;
    const updater = new AutoUpdater(config, event as unknown as WebhookEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handleSchedule();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });
});

describe('test `handleWorkflowDispatch`', () => {
  test('workflow dispatch event', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowDispatchEvent);

    const pullsMock: any[] = [];
    const expectedPulls = 5;
    for (let i = 0; i < expectedPulls; i++) {
      pullsMock.push({
        id: i,
        number: i,
      });
    }

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleWorkflowDispatch();

    expect(updated).toEqual(expectedPulls);
    expect(updateSpy).toHaveBeenCalledTimes(expectedPulls);
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
    expect(updateSpy).toHaveBeenCalledTimes(0);
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
    expect(updateSpy).toHaveBeenCalledTimes(0);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by push event on a branch with PRs', async () => {
    const updater = new AutoUpdater(config, dummyWorkflowRunPushEvent);

    const pullsMock: any[] = [];
    const expectedPulls = 5;
    for (let i = 0; i < expectedPulls; i++) {
      pullsMock.push({
        id: i,
        number: i,
      });
    }

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(expectedPulls);
    expect(updateSpy).toHaveBeenCalledTimes(expectedPulls);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by pull_request event with an update triggered', async () => {
    const updater = new AutoUpdater(
      config,
      dummyWorkflowRunPullRequestEvent as WorkflowRunEvent,
    );

    const pullsMock: any[] = [];
    const expectedPulls = 2;
    for (let i = 0; i < expectedPulls; i++) {
      pullsMock.push({
        id: i,
        number: i,
      });
    }

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, pullsMock);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(expectedPulls);
    expect(updateSpy).toHaveBeenCalledTimes(expectedPulls);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event by pull_request event without an update', async () => {
    const updater = new AutoUpdater(
      config,
      dummyWorkflowRunPullRequestEvent as WorkflowRunEvent,
    );

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(false);

    const scope = nock('https://api.github.com:443')
      .get(
        `/repos/${owner}/${repo}/pulls?base=${branch}&state=open&sort=updated&direction=desc`,
      )
      .reply(200, []);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
    expect(scope.isDone()).toEqual(true);
  });

  test('workflow_run event with an unsupported event type', async () => {
    const event = cloneEvent();
    event.workflow_run.event = 'pull_request_review';

    const updater = new AutoUpdater(config, event);

    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handleWorkflowRun();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
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

  test('pull request head repo is null, should log error and return false', async () => {
    const dummyPullRequestEvent = {
      action: 'synchronize',
      pull_request: {
        head: {
          repo: null,
        },
      },
    } as any;
    const updater = new AutoUpdater(config, dummyPullRequestEvent);
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.handlePullRequest();
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Pull request head repo is null, skipping update.',
    );
    errorSpy.mockRestore();
  });
});

describe('test `update`', () => {
  test('when a pull request does not need an update', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest
      .spyOn(updater, 'prNeedsUpdate')
      .mockResolvedValue(false);
    const needsUpdate = await updater.update(owner, <any>validPull);
    expect(needsUpdate).toEqual(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  test('dry run mode', async () => {
    (config.dryRun as jest.Mock).mockReturnValue(true);
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest
      .spyOn(updater, 'prNeedsUpdate')
      .mockResolvedValue(true);
    const mergeSpy = jest.spyOn(updater, 'merge');
    const needsUpdate = await updater.update(owner, <any>validPull);

    expect(needsUpdate).toEqual(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledTimes(0);
  });

  test('pull request without a head repository', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const updateSpy = jest
      .spyOn(updater, 'prNeedsUpdate')
      .mockResolvedValue(true);
    const mergeSpy = jest.spyOn(updater, 'merge');

    const pull = {
      ...validPull,
      head: {
        ...validPull.head,
        repo: null,
      },
    };

    const needsUpdate = await updater.update(owner, <any>pull);

    expect(needsUpdate).toEqual(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledTimes(0);
  });

  test('custom merge message', async () => {
    const mergeMsg = 'dummy-merge-msg';
    (config.mergeMsg as jest.Mock).mockReturnValue(mergeMsg);
    const updater = new AutoUpdater(config, emptyEvent);

    const updateSpy = jest
      .spyOn(updater, 'prNeedsUpdate')
      .mockResolvedValue(true);
    const mergeSpy = jest.spyOn(updater, 'merge').mockResolvedValue(true);
    const needsUpdate = await updater.update(owner, <any>validPull);

    const expectedMergeOpts = {
      owner: validPull.head.repo.owner.login,
      repo: validPull.head.repo.name,
      commit_message: mergeMsg,
      base: validPull.head.ref,
      head: validPull.base.ref,
    };

    expect(needsUpdate).toEqual(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith(
      owner,
      validPull.number,
      expectedMergeOpts,
    );
  });

  test('merge with no message', async () => {
    (config.mergeMsg as jest.Mock).mockReturnValue('');
    const updater = new AutoUpdater(config, emptyEvent);

    const updateSpy = jest
      .spyOn(updater, 'prNeedsUpdate')
      .mockResolvedValue(true);
    const mergeSpy = jest.spyOn(updater, 'merge').mockResolvedValue(true);
    const needsUpdate = await updater.update(owner, <any>validPull);

    const expectedMergeOpts = {
      owner: validPull.head.repo.owner.login,
      repo: validPull.head.repo.name,
      base: validPull.head.ref,
      head: validPull.base.ref,
    };

    expect(needsUpdate).toEqual(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith(
      owner,
      validPull.number,
      expectedMergeOpts,
    );
  });

  test('update: logs and sets failed if merge throws and error is instance of Error', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(updater, 'prNeedsUpdate').mockResolvedValue(true);
    const mergeError = new Error('merge failed');
    jest.spyOn(updater, 'merge').mockImplementation(() => {
      throw mergeError;
    });
    const setFailedSpy = jest
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {});
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.update(owner, <any>validPull);
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Caught error running merge, skipping and continuing with remaining PRs',
    );
    expect(setFailedSpy).toHaveBeenCalledWith(mergeError);
    setFailedSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('prNeedsUpdate: logs and returns false if compareCommitsWithBasehead throws', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const pull = { ...validPull };
    // Patch the compareCommitsWithBasehead method on the repos prototype
    const proto = Object.getPrototypeOf(updater.octokit.rest.repos);
    proto.compareCommitsWithBasehead = jest
      .fn()
      .mockRejectedValue(new Error('compare error'));
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.prNeedsUpdate(pull as any);
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Caught error trying to compare base with head: compare error',
    );
    errorSpy.mockRestore();
  });

  test('merge: returns false and sets output if 403 error and sourceEventOwner !== mergeOpts.owner', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('Forbidden');
    (error as any).status = 403;
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(error);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      'other-owner',
      1,
      {
        owner: 'not-owner',
        repo: 'repo',
        base: 'base',
        head: 'head',
      } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    expect(setOutputMock).toHaveBeenCalledWith(Output.Conflicted, false);
  });

  test('merge: returns false and sets output if authorization error with token message', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('Parameter token or opts.auth is required');
    (error as any).status = 401;
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(error);
    const setOutputMock = jest.fn();
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base, head } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    expect(setOutputMock).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not update pull request #1 due to an authorisation error. Error was: Parameter token or opts.auth is required. Please confirm you are using the correct token and it has the correct authorisation scopes.',
    );
  });

  test('merge: retries if error and retries < retryCount', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('retry me');
    const mergeMock = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 200, data: { sha: 'abc' } });
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = mergeMock;
    jest.spyOn(config, 'retryCount').mockReturnValue(1);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      {
        owner: owner,
        repo: repo,
        base: head,
        head: base,
      } as any,
      setOutputMock,
    );
    expect(result).toBe(true);
    expect(mergeMock).toHaveBeenCalledTimes(2);
  });

  test('merge: does not retry if error and retries >= retryCount', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('retry me');
    const mergeMock = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 200, data: { sha: 'abc' } });
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = mergeMock;
    jest.spyOn(config, 'retryCount').mockReturnValue(1);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      {
        owner: owner,
        repo: repo,
        base: head,
        head: base,
      } as any,
      setOutputMock,
    );
    expect(result).toBe(true);
    expect(mergeMock).toHaveBeenCalledTimes(2);
  });

  test('merge: retries up to max retries', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('Temporary error');
    const mergeMock = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: 200, data: { sha: 'abc' } });
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = mergeMock;
    jest.spyOn(config, 'retryCount').mockReturnValue(2);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      {
        owner: owner,
        repo: repo,
        base: head,
        head: base,
      } as any,
      setOutputMock,
    );
    expect(result).toBe(true);
    expect(mergeMock).toHaveBeenCalledTimes(2);
  });

  test('merge: throws error if max retries exceeded', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const error = new Error('Always fails');
    const mergeMock = jest.fn().mockRejectedValue(error);
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = mergeMock;
    jest.spyOn(config, 'retryCount').mockReturnValue(1);
    const setOutputMock = jest.fn();
    await expect(
      updater.merge(
        owner,
        1,
        { owner, repo, base, head } as any,
        setOutputMock,
      ),
    ).rejects.toThrow(error);
    expect(mergeMock).toHaveBeenCalledTimes(2);
  });
});

describe('coverage for missing branches in pulls()', () => {
  test('returns 0 and logs error if owner is missing', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const spy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.pulls(
      'refs/heads/main',
      'repo',
      undefined as any,
      undefined as any,
    );
    expect(result).toBe(0);
    expect(spy).toHaveBeenCalledWith('Invalid repository owner provided');
    spy.mockRestore();
  });
  test('returns 0 and logs error if repoName is missing', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const spy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const result = await updater.pulls(
      'refs/heads/main',
      undefined as any,
      'owner',
      'owner',
    );
    expect(result).toBe(0);
    expect(spy).toHaveBeenCalledWith('Invalid repository name provided');
    spy.mockRestore();
  });
});

describe('merge() doMerge and merge conflict label/branches', () => {
  test('doMerge: logs info and returns true if status is 204', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeMock = jest.fn().mockResolvedValue({ status: 204, data: {} });
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = mergeMock;
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base: head, head: base } as any,
      setOutputMock,
    );
    expect(result).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Branch update not required, branch is already up-to-date.',
    );
    infoSpy.mockRestore();
  });

  test('merge: mergeConflictAction label, label not present, adds label and comment', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('label');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('conflict');
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(new Error('Merge conflict'));
    Object.getPrototypeOf(updater.octokit.rest.pulls).get = jest
      .fn()
      .mockResolvedValue({ data: { labels: [{ name: 'foo' }] } });
    Object.getPrototypeOf(updater.octokit.rest.issues).update = jest
      .fn()
      .mockResolvedValue({});
    Object.getPrototypeOf(updater.octokit.rest.issues).createComment = jest
      .fn()
      .mockResolvedValue({});
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base: head, head: base } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    expect(
      Object.getPrototypeOf(updater.octokit.rest.issues).update,
    ).toHaveBeenCalled();
    expect(
      Object.getPrototypeOf(updater.octokit.rest.issues).createComment,
    ).toHaveBeenCalled();
  });

  test('merge: mergeConflictAction label, label already present, does not add label or comment', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('label');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('conflict');
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(new Error('Merge conflict'));
    Object.getPrototypeOf(updater.octokit.rest.pulls).get = jest
      .fn()
      .mockResolvedValue({ data: { labels: [{ name: 'conflict' }] } });
    const updateSpy = jest.spyOn(updater.octokit.rest.issues, 'update');
    const commentSpy = jest.spyOn(updater.octokit.rest.issues, 'createComment');
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base: head, head: base } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(commentSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
    commentSpy.mockRestore();
  });

  test('merge: mergeConflictAction fail, throws error and logs', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('fail');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('conflict');
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(new Error('Merge conflict'));
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    await expect(
      updater.merge(
        owner,
        1,
        { owner, repo, base: head, head: base } as any,
        setOutputMock,
      ),
    ).rejects.toThrow('Merge conflict');
    expect(errorSpy).toHaveBeenCalledWith(
      'Merge conflict error trying to update branch',
    );
    errorSpy.mockRestore();
  });

  test('merge: mergeConflictAction label, removes filter labels if PR filter is labelled', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('label');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('conflict');
    jest.spyOn(config, 'pullRequestFilter').mockReturnValue('labelled');
    jest.spyOn(config, 'pullRequestLabels').mockReturnValue(['foo', 'bar']);
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(new Error('Merge conflict'));
    Object.getPrototypeOf(updater.octokit.rest.pulls).get = jest
      .fn()
      .mockResolvedValue({
        data: { labels: [{ name: 'foo' }, { name: 'baz' }] },
      });
    const issuesUpdate = jest
      .spyOn(updater.octokit.rest.issues, 'update')
      .mockResolvedValue({} as any);
    const issuesComment = jest
      .spyOn(updater.octokit.rest.issues, 'createComment')
      .mockResolvedValue({} as any);
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base: head, head: base } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    // Should remove 'foo' and 'bar', add 'conflict', keep 'baz'
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(['baz', 'conflict']),
      }),
    );
    expect(issuesComment).toHaveBeenCalled();
    issuesUpdate.mockRestore();
    issuesComment.mockRestore();
  });

  test('merge: mergeConflictAction ignore, skips update and logs', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('ignore');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('conflict');
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(new Error('Merge conflict'));
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1);
    const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      1,
      { owner, repo, base: head, head: base } as any,
      setOutputMock,
    );
    expect(result).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      'Merge conflict detected, skipping update.',
    );
    infoSpy.mockRestore();
  });
});

describe('AutoUpdater.merge authorisation error handling', () => {
  test('handles missing token or opts.auth error', async () => {
    const updater = new AutoUpdater(config, emptyEvent);
    const mergeOpts = { owner, repo, base, head };
    // Create an Error instance and add status property
    const error: Error & { status?: number } = new Error(
      'Parameter token or opts.auth is required',
    );
    error.status = 401;
    // Mock octokit.rest.repos.merge to throw the specific error
    Object.getPrototypeOf(updater.octokit.rest.repos).merge = jest
      .fn()
      .mockRejectedValue(error);
    // Mock isRequestError to return true
    jest.spyOn(isRequestErrorModule, 'isRequestError').mockReturnValue(true);
    const errorSpy = jest.spyOn(core, 'error').mockImplementation(() => {});
    const setOutputMock = jest.fn();
    const result = await updater.merge(
      owner,
      123,
      mergeOpts as any,
      setOutputMock,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Could not update pull request #123 due to an authorisation error. Error was: Parameter token or opts.auth is required.',
      ),
    );
    expect(setOutputMock).toHaveBeenCalledWith(Output.Conflicted, false);
    expect(result).toBe(false);
    errorSpy.mockRestore();
  });
});
