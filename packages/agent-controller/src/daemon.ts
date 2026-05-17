import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PID_FILE = join(tmpdir(), 'agent-controller.pid');

export function writePid(): void {
  writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const content = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

export function removePid(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

export function isRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
