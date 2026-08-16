// `@actions/github` resolves the API base URL once, when the module is first
// loaded, so GITHUB_API_URL has to be set before anything imports it. `import`
// statements are hoisted above this assignment, so the modules under test are
// pulled in with `require` instead. Jest gives each test file its own module
// registry, which is why this regression test lives in a file of its own.
process.env.GITHUB_API_URL = 'https://github.example.com/api/v3';

if ('GITHUB_TOKEN' in process.env) {
  delete process.env.GITHUB_TOKEN;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const nock: typeof import('nock') = require('nock');
const {
  GitHubService,
}: typeof import('../../src/services/GitHubService') = require('../../src/services/GitHubService');
/* eslint-enable @typescript-eslint/no-require-imports */

const token = 'test-token';

beforeAll(() => {
  // Fail loudly rather than reaching the real API if an expectation is wrong.
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
  delete process.env.GITHUB_API_URL;
});

// Regression test: both clients must come from `getOctokit` so they inherit the
// runner's API base URL. A stand-alone GraphQL client always targets
// api.github.com, which silently breaks rebase on GitHub Enterprise Server.
describe('GitHubService on GitHub Enterprise Server', () => {
  test('rebaseBranch posts to the enterprise GraphQL endpoint', async () => {
    // GHES serves GraphQL from /api/graphql, not /api/v3/graphql.
    const enterprise = nock('https://github.example.com:443')
      .post('/api/graphql')
      .reply(200, {
        data: { updatePullRequestBranch: { pullRequest: { id: 'PR_node_1' } } },
      });

    const service = new GitHubService(token);
    await service.rebaseBranch('PR_node_1');

    expect(enterprise.isDone()).toEqual(true);
  });

  test('REST calls also target the enterprise host', async () => {
    const enterprise = nock('https://github.example.com:443')
      .get('/api/v3/repos/an-owner/a-repo/branches/master')
      .reply(200, { protected: true });

    const service = new GitHubService(token);
    const { data } = await service.getBranch('an-owner', 'a-repo', 'master');

    expect(data.protected).toEqual(true);
    expect(enterprise.isDone()).toEqual(true);
  });
});
