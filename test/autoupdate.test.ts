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

  test('push event with invalid owner', async () => {
    const invalidPushEvent = {
      ref: `refs/heads/${branch}`,
      repository: {
        owner: {
          login: '',
        },
        name: repo,
      },
    } as any;
    const updater = new AutoUpdater(config, invalidPushEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handlePush();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
  });

  test('push event with invalid repo name', async () => {
    const invalidPushEvent = {
      ref: `refs/heads/${branch}`,
      repository: {
        owner: {
          login: owner,
        },
        name: '',
      },
    } as any;
    const updater = new AutoUpdater(config, invalidPushEvent);
    const updateSpy = jest.spyOn(updater, 'update').mockResolvedValue(true);

    const updated = await updater.handlePush();

    expect(updated).toEqual(0);
    expect(updateSpy).toHaveBeenCalledTimes(0);
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
});

describe('test `merge`', () => {
  let updater: AutoUpdater;
  let octokitMock: any;
  let setOutputMock: jest.Mock;

  const prNumber = 1;
  const mergeOpts = {
    owner: owner,
    repo: repo,
    base: head,
    head: base,
  };

  beforeEach(() => {
    setOutputMock = jest.fn();
    updater = new AutoUpdater(config, emptyEvent);
    octokitMock = updater.octokit;
    jest.spyOn(config, 'retryCount').mockReturnValue(2);
    jest.spyOn(config, 'retrySleep').mockReturnValue(1); // 1ms for fast tests
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('fail');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('merge-conflict');
  });

  test('successful merge (status 200)', async () => {
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockResolvedValue({ status: 200, data: { sha: 'abc' } }),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    const result = await updater.merge(
      owner,
      prNumber,
      mergeOpts,
      setOutputMock
    );
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalledWith(mergeOpts);
    expect(setOutputMock).toHaveBeenCalledWith(expect.anything(), false);
  });

  test('merge not required (status 204)', async () => {
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockResolvedValue({ status: 204, data: {} }),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    const result = await updater.merge(
      owner,
      prNumber,
      mergeOpts,
      setOutputMock
    );
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalledWith(mergeOpts);
    expect(setOutputMock).toHaveBeenCalledWith(expect.anything(), false);
  });

  test('merge conflict throws and mergeConflictAction=fail', async () => {
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(new Error('Merge conflict')),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    await expect(
      updater.merge(
        owner,
        prNumber,
        mergeOpts,
        setOutputMock
      )
    ).resolves.toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalled();
    expect(setOutputMock).toHaveBeenCalledWith(expect.anything(), false);
  });

  test('403 error for forked PRs', async () => {
    const error: any = new Error('Forbidden');
    error.status = 403;
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(error),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    await expect(
      updater.merge(
        'other-owner',
        prNumber,
        mergeOpts,
        setOutputMock
      )
    ).resolves.toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalled();
  });

  test('retry logic: fails once, then succeeds', async () => {
    const error = new Error('Temporary error');
    octokitMock.rest = {
      repos: {
        merge: jest
          .fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({ status: 200, data: { sha: 'abc' } }),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    const result = await updater.merge(
      owner,
      prNumber,
      mergeOpts,
      setOutputMock
    );
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalledTimes(2);
  });

  test('max retries exceeded', async () => {
    const error = new Error('Always fails');
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(error),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    jest.spyOn(config, 'retryCount').mockReturnValue(1);
    const result = await updater.merge(
      owner,
      prNumber,
      mergeOpts,
      setOutputMock
    );
    expect(result).toBe(true); // always returns true, but logs error
    expect(octokitMock.rest.repos.merge).toHaveBeenCalledTimes(2);
  });

  test('merge works when setOutputMock is not provided', async () => {
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockResolvedValue({ status: 200, data: { sha: 'abc' } }),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    // setOutputMock is undefined
    const result = await updater.merge(owner, prNumber, mergeOpts);
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalledWith(mergeOpts);
  });

  test('merge throws unexpected error', async () => {
    const error = new Error('Unexpected error');
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(error),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    jest.spyOn(config, 'retryCount').mockReturnValue(0);
    const result = await updater.merge(owner, prNumber, mergeOpts, setOutputMock);
    expect(result).toBe(true); // merge always returns true, but logs error
    expect(octokitMock.rest.repos.merge).toHaveBeenCalled();
  });

  test('mergeConflictAction label: should attempt to add label', async () => {
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('label');
    jest.spyOn(config, 'mergeConflictLabel').mockReturnValue('merge-conflict');
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(new Error('Merge conflict')),
      },
      issues: {
        addLabels: jest.fn().mockResolvedValue({ status: 200 }),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    updater.octokit.rest.issues = octokitMock.rest.issues;
    const result = await updater.merge(owner, prNumber, mergeOpts, setOutputMock);
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalled();
    expect(octokitMock.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: mergeOpts.owner,
      repo: mergeOpts.repo,
      issue_number: prNumber,
      labels: ['merge-conflict'],
    });
  });

  test('mergeConflictAction ignore: should ignore merge conflict', async () => {
    jest.spyOn(config, 'mergeConflictAction').mockReturnValue('ignore');
    octokitMock.rest = {
      repos: {
        merge: jest.fn().mockRejectedValue(new Error('Merge conflict')),
      },
    };
    updater.octokit.rest = octokitMock.rest;
    const result = await updater.merge(owner, prNumber, mergeOpts, setOutputMock);
    expect(result).toBe(true);
    expect(octokitMock.rest.repos.merge).toHaveBeenCalled();
  });
});

