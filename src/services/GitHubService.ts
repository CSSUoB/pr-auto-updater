import * as github from '@actions/github';
import { GitHub } from '@actions/github/lib/utils';
import type * as octokit from '@octokit/types';

export type MergeParameters =
  octokit.Endpoints['POST /repos/{owner}/{repo}/merges']['parameters'];

const REBASE_MUTATION = `
  mutation updatePR($input: UpdatePullRequestBranchInput!) {
    updatePullRequestBranch(input: $input) {
      pullRequest { id }
    }
  }
`;

export class GitHubService {
  public rest: InstanceType<typeof GitHub>['rest'];
  public paginate: InstanceType<typeof GitHub>['paginate'];
  private graphql: InstanceType<typeof GitHub>['graphql'];

  constructor(token: string) {
    // `getOctokit` resolves `baseUrl` from `GITHUB_API_URL` and wires up the
    // runner's proxy configuration, so all three clients must come from it —
    // a hand-rolled client would always target api.github.com and break on
    // GitHub Enterprise Server and behind proxies.
    const client = github.getOctokit(token);
    this.rest = client.rest;
    this.paginate = client.paginate;
    this.graphql = client.graphql;
  }

  async compareCommits(owner: string, repo: string, basehead: string) {
    return this.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
    });
  }

  async getBranch(owner: string, repo: string, branch: string) {
    return this.rest.repos.getBranch({ owner, repo, branch });
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    return this.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  }

  async updateIssueLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ) {
    return this.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ) {
    return this.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async mergeBranch(mergeOpts: MergeParameters) {
    return this.rest.repos.merge(mergeOpts);
  }

  async rebaseBranch(pullRequestId: string) {
    return this.graphql(REBASE_MUTATION, {
      input: { pullRequestId, updateMethod: 'REBASE' },
    });
  }
}
