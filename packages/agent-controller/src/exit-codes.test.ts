import { describe, it, expect } from 'vitest';
import {
  EXIT_SERVER_SHUTDOWN,
  isFailureShutdownReason,
  isServerTerminationReason,
  isSignalShutdownReason,
  resolveShutdownExitCode,
} from './exit-codes.js';

describe('exit codes (contract §3.7)', () => {
  it('T-EC1: EXIT_SERVER_SHUTDOWN is 42', () => {
    expect(EXIT_SERVER_SHUTDOWN).toBe(42);
  });

  it('T-EC2: signals exit 0 (keepalive restarts after accidental kill)', () => {
    for (const reason of ['SIGINT', 'SIGTERM', 'signal: SIGTERM', ' worker shutdown: sigterm ']) {
      expect(isSignalShutdownReason(reason)).toBe(true);
      expect(resolveShutdownExitCode(reason)).toBe(0);
    }
  });

  it('T-EC3: server termination reasons exit 42', () => {
    const reasons = [
      'unregistered',
      'worker shutdown: unregistered',
      'controller-api shutdown: unregistered',
      'error: INVALID_TOKEN',
      'worker shutdown: error: INVALID_TOKEN',
      'worker shutdown: error:invalid_token',
    ];
    for (const reason of reasons) {
      expect(isServerTerminationReason(reason)).toBe(true);
      expect(resolveShutdownExitCode(reason)).toBe(42);
    }
  });

  it('T-EC4: failure reasons exit 1', () => {
    const reasons = [
      'version_mismatch: agent-gear 版本不兼容',
      'worker shutdown: version_mismatch: too old',
      'error: REGISTER_FAILED',
      'controller-api shutdown: error: UNKNOWN',
      '必须工作负载「OpenCode（Harness）」初始化失败',
      'worker shutdown: 必须工作负载「x」初始化失败',
      'required init failed',
      'required initialization failed',
    ];
    for (const reason of reasons) {
      expect(isFailureShutdownReason(reason)).toBe(true);
      expect(resolveShutdownExitCode(reason)).toBe(1);
    }
  });

  it('T-EC5: plain server shutdown falls through to 42', () => {
    expect(resolveShutdownExitCode('server requested shutdown')).toBe(42);
    expect(resolveShutdownExitCode('worker shutdown: 强制销毁')).toBe(42);
    expect(resolveShutdownExitCode('controller-api shutdown: key_revoked')).toBe(42);
  });

  it('T-EC6: INVALID_TOKEN overrides the generic error: failure prefix', () => {
    expect(isFailureShutdownReason('error: INVALID_TOKEN')).toBe(true);
    expect(resolveShutdownExitCode('error: INVALID_TOKEN')).toBe(42);
  });
});

describe('contract anchor', () => {
  it('T-EC7: contract documents exit code 42', async () => {
    const { readFileSync } = await import('node:fs');
    const contract = readFileSync(new URL('../../../contracts/agent-controller-websocket.md', import.meta.url), 'utf8');
    expect(contract).toContain('`42`');
    expect(contract).toContain('EXIT_SERVER_SHUTDOWN');
  });
});
