import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const REGISTRY_DIR = join(homedir(), '.zag');
const REGISTRY_FILE = join(REGISTRY_DIR, 'processes.json');

interface ProcessEntry {
  sessionId: string;
  pid: number;
  cwd: string;
  acpServerType: string;
  startedAt: string;
}

interface RegistryFile {
  version: 1;
  processes: ProcessEntry[];
}

export interface ProcessInfo {
  pid: number;
  cwd: string;
  acpServerType: string;
  startedAt: string;
}

function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but is owned by another user — alive, not dead
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRaw(): RegistryFile | null {
  if (!existsSync(REGISTRY_FILE)) return null;
  try {
    const content = readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1 || !Array.isArray(obj.processes)) return null;
    return { version: 1, processes: obj.processes as ProcessEntry[] };
  } catch {
    return null;
  }
}

function writeRaw(data: RegistryFile): void {
  ensureDir();
  // Temp file lives inside REGISTRY_DIR: rename is only atomic on the same
  // filesystem (writing to os.tmpdir() first breaks with EXDEV on Linux).
  const tmpFile = join(REGISTRY_DIR, `processes-${Date.now()}-${Math.random().toString(36).slice(2)}.json.tmp`);
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpFile, REGISTRY_FILE);
}

export class ProcessRegistry {
  private processes: Map<string, ProcessEntry> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    const raw = readRaw();
    if (!raw) {
      this.processes = new Map();
      return;
    }

    const alive = new Map<string, ProcessEntry>();
    for (const entry of raw.processes) {
      if (isProcessAlive(entry.pid)) {
        alive.set(entry.sessionId, entry);
      }
    }

    if (alive.size !== raw.processes.length) {
      writeRaw({ version: 1, processes: Array.from(alive.values()) });
    }

    this.processes = alive;
  }

  register(sessionId: string, info: Omit<ProcessInfo, 'startedAt'> & { startedAt?: string }): void {
    const entry: ProcessEntry = {
      sessionId,
      pid: info.pid,
      cwd: info.cwd,
      acpServerType: info.acpServerType,
      startedAt: info.startedAt ?? new Date().toISOString(),
    };
    this.processes.set(sessionId, entry);
    this.flush();
  }

  deregister(sessionId: string): boolean {
    const existed = this.processes.delete(sessionId);
    if (existed) this.flush();
    return existed;
  }

  list(): ProcessInfo[] {
    return Array.from(this.processes.values()).map(({ sessionId: _, ...rest }) => rest);
  }

  listEntries(): ProcessEntry[] {
    return Array.from(this.processes.values());
  }

  get(sessionId: string): ProcessInfo | undefined {
    const entry = this.processes.get(sessionId);
    if (!entry) return undefined;
    const { sessionId: _, ...rest } = entry;
    return rest;
  }

  private flush(): void {
    try {
      writeRaw({ version: 1, processes: Array.from(this.processes.values()) });
    } catch (err) {
      // Persistence is best-effort: a flush failure must never crash the
      // controller (this can be called from timer callbacks).
      console.warn(`[ProcessRegistry] flush failed: ${(err as Error).message}`);
    }
  }
}

export const processRegistry = new ProcessRegistry();
