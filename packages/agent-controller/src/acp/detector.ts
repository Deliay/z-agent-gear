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
    const [opencode, copilot, claudeCode, geminiCli, codex, mimoCode, kimiCode] = await Promise.all([
      this.detectOpenCode(),
      this.detectGitHubCopilot(),
      this.detectClaudeCode(),
      this.detectGeminiCli(),
      this.detectCodex(),
      this.detectMiMoCode(),
      this.detectKimiCode(),
    ]);
    return [opencode, copilot, claudeCode, geminiCli, codex, mimoCode, kimiCode];
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

  private async detectClaudeCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('claude-agent-acp --version');
      const version = this.parseVersion(stdout);
      return { type: 'claude_code', available: true, version };
    } catch {
      return { type: 'claude_code', available: false };
    }
  }

  private async detectGeminiCli(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('gemini --version');
      const version = this.parseVersion(stdout);
      return { type: 'gemini_cli', available: true, version };
    } catch {
      return { type: 'gemini_cli', available: false };
    }
  }

  private async detectCodex(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('codex-acp --version');
      const version = this.parseVersion(stdout);
      return { type: 'codex', available: true, version };
    } catch {
      return { type: 'codex', available: false };
    }
  }

  private async detectMiMoCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('mimo --version');
      const version = this.parseVersion(stdout);
      return { type: 'mimo_code', available: true, version };
    } catch {
      return { type: 'mimo_code', available: false };
    }
  }

  private async detectKimiCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('kimi --version');
      const version = this.parseVersion(stdout);
      return { type: 'kimi_code', available: true, version };
    } catch {
      return { type: 'kimi_code', available: false };
    }
  }

  getSpawnerConfig(serverType: string): { command: string; args: string[] } {
    switch (serverType) {
      case 'github_copilot':
        return { command: 'copilot', args: ['--acp', '--stdio'] };
      case 'claude_code':
        return { command: 'claude-agent-acp', args: [] };
      case 'gemini_cli':
        return { command: 'gemini', args: ['--acp'] };
      case 'codex':
        return { command: 'codex-acp', args: [] };
      case 'mimo_code':
        return { command: 'mimo', args: ['acp'] };
      case 'kimi_code':
        return { command: 'kimi', args: ['acp'] };
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