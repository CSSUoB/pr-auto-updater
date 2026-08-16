import * as github from '@actions/github';
import { GitHub } from '@actions/github/lib/utils';
import { graphql } from '@octokit/graphql';
import type * as octokit from '@octokit/types';

export type MergeParameters =
  octokit.Endpoints['POST /repos/{owner}/{repo}/merges']['parameters'];

export class GitHubService {
  public rest: InstanceType<typeof GitHub>['rest'];
  public paginate: InstanceType<typeof GitHub>['paginate'];
  private token: string;

  constructor(token: string) {
    this.token = token;
    const client = github.getOctokit(token);
    this.rest = client.rest;
    this.paginate = client.paginate;
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
    const mutation = `
      mutation updatePR($input: UpdatePullRequestBranchInput!) {
        updatePullRequestBranch(input: $input) {
          pullRequest { id }
        }
      }
    `;
    const graphqlWithAuth = graphql.defaults({
      headers: { authorization: `token ${this.token}` },
    });
    return graphqlWithAuth(mutation, {
      input: { pullRequestId, updateMethod: 'REBASE' },
    });
  }
}
