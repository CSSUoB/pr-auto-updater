import * as core from '@actions/core';
import * as github from '@actions/github';
import { createAppAuth } from '@octokit/auth-app';
import { GitHub } from '@actions/github/lib/utils';

export interface AuthenticationConfig {
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: string;
}

export class GitHubAuthenticator {
  private config: AuthenticationConfig;

  constructor(config: AuthenticationConfig) {
    this.config = config;
  }

  /**
   * Gets an authentication token
   * Supports both GitHub App authentication and personal access tokens
   */
  async getToken(): Promise<string> {
    if (this.config.token) {
      // Use personal access token
      return this.config.token;
    }

    if (this.config.appId && this.config.privateKey) {
      // Use GitHub App authentication
      return await this.generateAppToken();
    }

    throw new Error(
      'No valid authentication method provided. Please provide either a token or GitHub App credentials.',
    );
  }

  /**
   * Creates an authenticated GitHub client using @actions/github
   */
  async createGitHubClient(): Promise<InstanceType<typeof GitHub>> {
    const token = await this.getToken();
    return github.getOctokit(token);
  }

  /**
   * Generates a GitHub App installation token
   */
  async generateAppToken(): Promise<string> {
    if (!this.config.appId || !this.config.privateKey) {
      throw new Error(
        'GitHub App ID and private key are required for app authentication',
      );
    }

    const { owner, repo } = github.context.repo;

    const auth = createAppAuth({
      appId: this.config.appId,
      privateKey: this.config.privateKey.replace(/\\n/g, '\n'),
    });

    // If installation ID is provided, use it directly
    if (this.config.installationId) {
      const installationAuth = await auth({
        type: 'installation',
        installationId: parseInt(this.config.installationId, 10),
      });
      return installationAuth.token;
    }

    // Otherwise, find the installation ID for the current repository
    const appAuth = await auth({ type: 'app' });

    // Create a temporary client to find the installation
    const tempClient = github.getOctokit(appAuth.token);

    try {
      const installations = await tempClient.request('GET /app/installations');
      const installation = installations.data.find(
        (i: any) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
      );

      if (!installation) {
        throw new Error(
          `GitHub App is not installed for ${owner}/${repo}. Please install the app or provide the installation ID.`,
        );
      }

      const installationAuth = await auth({
        type: 'installation',
        installationId: installation.id,
      });

      return installationAuth.token;
    } catch (error) {
      throw new Error(
        `Failed to authenticate with GitHub App: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Creates an authenticator from environment variables and action inputs
   */
  static fromEnvironment(): GitHubAuthenticator {
    const config: AuthenticationConfig = {
      token: core.getInput('token') || process.env.GITHUB_TOKEN,
      appId: '1363586',
      privateKey:
        core.getInput('private-key') || process.env.GH_APP_PRIVATE_KEY,
      installationId:
        core.getInput('installation-id') || process.env.GH_APP_INSTALLATION_ID,
    };

    return new GitHubAuthenticator(config);
  }

  /**
   * Validates that at least one authentication method is available
   */
  validateConfig(): void {
    const hasToken = !!this.config.token;
    const hasAppCredentials = !!(this.config.appId && this.config.privateKey);

    if (!hasToken && !hasAppCredentials) {
      throw new Error(
        'No authentication method available. Please provide either:\n' +
          '- A GitHub token via the "token" input or GITHUB_TOKEN environment variable\n' +
          '- GitHub App credentials via "app-id" and "private-key" inputs or GH_APP_ID and GH_APP_PRIVATE_KEY environment variables',
      );
    }
  }
}
