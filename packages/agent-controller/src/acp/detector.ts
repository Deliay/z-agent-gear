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
    const servers: AcpServerInfo[] = [];

    // Detect OpenCode
    const opencode = await this.detectOpenCode();
    servers.push(opencode);

    return servers;
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

  private parseVersion(output: string): string {
    // Try to extract version from output
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }
}

export const acpDetector = new AcpDetector();