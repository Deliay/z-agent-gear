import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface AcpServerInfo {
  type: string;
  available: boolean;
  version?: string;
}

export class AcpDetector {
  async detect(): Promise<AcpServerInfo[]> {
    const [opencode, copilot] = await Promise.all([
      this.detectOpenCode(),
      this.detectGitHubCopilot(),
    ]);
    return [opencode, copilot];
  }

  private async detectOpenCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('opencode -v');
      const version = this.parseVersion(stdout);
      return { type: 'opencode', available: true, version };
    } catch {
      return { type: 'opencode', available: false };
    }
  }

  private async detectGitHubCopilot(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('copilot --version');
      const version = this.parseVersion(stdout);
      return { type: 'github_copilot', available: true, version };
    } catch {
      return { type: 'github_copilot', available: false };
    }
  }

  getSpawnerConfig(serverType: string): { command: string; args: string[] } {
    switch (serverType) {
      case 'github_copilot':
        return { command: 'copilot', args: ['--acp', '--stdio'] };
      case 'opencode':
      default:
        return { command: 'opencode', args: ['acp'] };
    }
  }

  private parseVersion(output: string): string {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }
}

export const acpDetector = new AcpDetector();