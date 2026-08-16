// Workaround for tests attempting to hit the GH API if running in an env where
// this variable is automatically set.
if ('GITHUB_TOKEN' in process.env) {
  delete process.env.GITHUB_TOKEN;
}

import nock from 'nock';
import { GitHubService } from '../../src/services/GitHubService';

const owner = 'chinthakagodawita';
const repo = 'not-a-real-repo';
const base = 'master';
const head = 'develop';
const token = 'test-token';
const api = 'https://api.github.com:443';

afterEach(() => {
  nock.cleanAll();
  delete process.env.GITHUB_API_URL;
});

describe('GitHubService REST methods', () => {
  test('compareCommits requests the given basehead', async () => {
    const scope = nock(api)
      .get(`/repos/${owner}/${repo}/compare/${head}...${base}`)
      .reply(200, { behind_by: 3 });

    const service = new GitHubService(token);
    const { data } = await service.compareCommits(
      owner,
      repo,
      `${head}...${base}`,
    );

    expect(data.behind_by).toEqual(3);
    expect(scope.isDone()).toEqual(true);
  });

  test('getBranch requests the given branch', async () => {
    const scope = nock(api)
      .get(`/repos/${owner}/${repo}/branches/${base}`)
      .reply(200, { protected: true });

    const service = new GitHubService(token);
    const { data } = await service.getBranch(owner, repo, base);

    expect(data.protected).toEqual(true);
    expect(scope.isDone()).toEqual(true);
  });

  test('getPullRequest requests the given pull request', async () => {
    const scope = nock(api)
      .get(`/repos/${owner}/${repo}/pulls/1`)
      .reply(200, { number: 1 });

    const service = new GitHubService(token);
    const { data } = await service.getPullRequest(owner, repo, 1);

    expect(data.number).toEqual(1);
    expect(scope.isDone()).toEqual(true);
  });

  test('updateIssueLabels sends the full label set', async () => {
    const scope = nock(api)
      .patch(`/repos/${owner}/${repo}/issues/1`, {
        labels: ['conflict', 'keep-me'],
      })
      .reply(200, {});

    const service = new GitHubService(token);
    await service.updateIssueLabels(owner, repo, 1, ['conflict', 'keep-me']);

    expect(scope.isDone()).toEqual(true);
  });

  test('createIssueComment posts the given body', async () => {
    const scope = nock(api)
      .post(`/repos/${owner}/${repo}/issues/1/comments`, {
        body: 'a comment',
      })
      .reply(201, {});

    const service = new GitHubService(token);
    await service.createIssueComment(owner, repo, 1, 'a comment');

    expect(scope.isDone()).toEqual(true);
  });

  test('mergeBranch posts the given merge options', async () => {
    const scope = nock(api)
      .post(`/repos/${owner}/${repo}/merges`, {
        base: head,
        head: base,
        commit_message: 'a message',
      })
      .reply(201, { sha: 'abc123' });

    const service = new GitHubService(token);
    const resp = await service.mergeBranch({
      owner,
      repo,
      base: head,
      head: base,
      commit_message: 'a message',
    });

    expect(resp.data.sha).toEqual('abc123');
    expect(scope.isDone()).toEqual(true);
  });
});

describe('GitHubService.rebaseBranch', () => {
  const graphqlOk = {
    data: { updatePullRequestBranch: { pullRequest: { id: 'PR_node_1' } } },
  };

  test('sends an UpdatePullRequestBranch mutation with REBASE', async () => {
    let requestBody: any;
    const scope = nock(api)
      .post('/graphql', (body) => {
        requestBody = body;
        return true;
      })
      .reply(200, graphqlOk);

    const service = new GitHubService(token);
    await service.rebaseBranch('PR_node_1');

    expect(scope.isDone()).toEqual(true);
    expect(requestBody.query).toContain('updatePullRequestBranch');
    expect(requestBody.variables.input).toEqual({
      pullRequestId: 'PR_node_1',
      updateMethod: 'REBASE',
    });
  });

  test('authenticates the mutation with the configured token', async () => {
    const scope = nock(api, {
      reqheaders: { authorization: `token ${token}` },
    })
      .post('/graphql')
      .reply(200, graphqlOk);

    const service = new GitHubService(token);
    await service.rebaseBranch('PR_node_1');

    expect(scope.isDone()).toEqual(true);
  });

  // See GitHubService.enterprise.test.ts for the GitHub Enterprise Server
  // base URL regression test, which needs its own module registry.

  test('rejects when the mutation returns GraphQL errors', async () => {
    nock(api)
      .post('/graphql')
      .reply(200, {
        data: null,
        errors: [
          {
            type: 'UNPROCESSABLE',
            message: 'merge conflict between base and head',
          },
        ],
      });

    const service = new GitHubService(token);

    await expect(service.rebaseBranch('PR_node_1')).rejects.toThrow(
      /merge conflict/,
    );
  });
});
