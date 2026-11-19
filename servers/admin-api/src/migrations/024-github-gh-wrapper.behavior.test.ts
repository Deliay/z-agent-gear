import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_WRAPPER_SCRIPT, GH_WRAPPER_MARKER, GITHUB_INIT_SCRIPT_V3 } from './024-github-gh-wrapper.js';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const TOKEN = 'ghs_project_token';

let dir = '';
let wrapper = '';
let realGh = '';
let agentGear = '';
let ghLog = '';
let agentGearLog = '';

function writeStub(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zag-gh-wrapper-'));
  wrapper = join(dir, 'gh');
  realGh = join(dir, 'gh.real');
  agentGear = join(dir, 'agent-gear');
  ghLog = join(dir, 'gh.log');
  agentGearLog = join(dir, 'agent-gear.log');

  writeFileSync(wrapper, GH_WRAPPER_SCRIPT, 'utf8');
  chmodSync(wrapper, 0o755);

  writeStub(
    realGh,
    `#!/bin/bash
{ echo "argv:$*"; echo "GITHUB_TOKEN:\${GITHUB_TOKEN-<unset>}"; } >> "$GH_LOG"
if [ "\${STUB_CAT:-}" = "1" ]; then cat; fi
exit "\${STUB_EXIT:-0}"
`,
  );

  writeStub(
    agentGear,
    `#!/bin/bash
echo "called" >> "$AGENT_GEAR_LOG"
if [ -n "\${AGENT_GEAR_STDOUT:-}" ]; then printf '%b' "$AGENT_GEAR_STDOUT"; fi
exit "\${AGENT_GEAR_EXIT:-0}"
`,
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reset(): void {
  rmSync(ghLog, { force: true });
  rmSync(agentGearLog, { force: true });
}

function run(
  args: string[],
  overrides: Record<string, string | undefined> = {},
  input?: string,
): RunResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GH_LOG: ghLog,
    AGENT_GEAR_LOG: agentGearLog,
    ZAG_GH_REAL: realGh,
    ZAG_AGENT_GEAR_BIN: agentGear,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync('/bin/bash', [wrapper, ...args], { env, input, encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function ghCalls(): string[] {
  return existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : [];
}

describe('gh wrapper behavior (T-WRP)', () => {
  it('T-WRP1: injects the project token and forwards argv/exit code', () => {
    reset();
    const result = run(['repo', 'view'], {
      AGENT_GEAR_STDOUT: TOKEN,
      STUB_EXIT: '7',
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toBe('');
    expect(ghCalls()).toEqual([`argv:repo view`, `GITHUB_TOKEN:${TOKEN}`]);
  });

  it('T-WRP2: exit 3 (not a github project) is silent', () => {
    reset();
    const result = run(['--version'], { AGENT_GEAR_EXIT: '3' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(ghCalls()).toContain('GITHUB_TOKEN:<unset>');
  });

  it.each([['4'], ['5'], ['6']])('T-WRP3: exit %s prints one line and still runs gh', (code) => {
    reset();
    const result = run(['--version'], { AGENT_GEAR_EXIT: code });
    expect(result.status).toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(`agent-gear exit ${code}`);
    expect(ghCalls()).toContain('GITHUB_TOKEN:<unset>');
  });

  it.each([['line1\\nline2'], ['has space'], ['tab\\there'], ['x'.repeat(4097)]])(
    'T-WRP4: rejects suspicious agent-gear output %#',
    (output) => {
      reset();
      const result = run(['--version'], { AGENT_GEAR_STDOUT: output });
      expect(result.status).toBe(0);
      expect(ghCalls()).toContain('GITHUB_TOKEN:<unset>');
      expect(ghCalls().join('\n')).not.toContain(output.slice(0, 8));
    },
  );

  it('T-WRP5: ZAG_GH_WRAPPER_SKIP_TOKEN bypasses agent-gear entirely', () => {
    reset();
    const result = run(['--version'], {
      ZAG_GH_WRAPPER_SKIP_TOKEN: '1',
      AGENT_GEAR_STDOUT: TOKEN,
    });
    expect(result.stderr).toBe('');
    expect(existsSync(agentGearLog)).toBe(false);
    expect(ghCalls()).toContain('GITHUB_TOKEN:<unset>');
  });

  it('T-WRP6: missing agent-gear prints a 127 hint and still runs gh', () => {
    reset();
    const result = run(
      ['--version'],
      {
        // PATH 中无 agent-gear；固定候选路径在本测试机不存在时同样走降级
        PATH: '/nonexistent',
        ZAG_AGENT_GEAR_BIN: undefined,
      },
    );
    // 若容器恰好预装了候选路径上的 agent-gear，则只断言行为等价（仍执行 gh、不注入 token）
    if (!existsSync('/home/worker/.local/share/pnpm/agent-gear')) {
      expect(result.stderr).toContain('agent-gear exit 127');
    }
    expect(result.status).toBe(0);
    expect(ghCalls()).toContain('GITHUB_TOKEN:<unset>');
  });

  it('T-WRP7: stdin is passed through to the real gh', () => {
    reset();
    const result = run(['auth', 'login', '--with-token'], { STUB_CAT: '1' }, 'stdin-payload');
    expect(result.stdout).toBe('stdin-payload');
  });

  it('T-WRP8: ZAG_GH_REAL overrides the real gh path', () => {
    reset();
    const alternative = join(dir, 'gh.alt');
    writeStub(alternative, '#!/bin/bash\necho alt >> "$GH_LOG"\n');
    const result = run(['--version'], {
      ZAG_GH_REAL: alternative,
      ZAG_GH_WRAPPER_SKIP_TOKEN: '1',
    });
    expect(result.status).toBe(0);
    expect(ghCalls()).toEqual(['alt']);
  });

  it('T-WRP9: a missing real gh exits 127 before any token request', () => {
    reset();
    const result = run(['--version'], {
      ZAG_GH_REAL: join(dir, 'does-not-exist'),
      AGENT_GEAR_STDOUT: TOKEN,
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('未找到原生 gh');
    expect(existsSync(agentGearLog)).toBe(false);
  });

  it('T-WRP10: repeated install (anchor early exit) leaves the wrapper untouched', () => {
    reset();
    const anchor = GITHUB_INIT_SCRIPT_V3
      .split('# 0) 幂等锚点')[1]!
      .split('# 1) 确保真实 gh')[0]!;
    const script = join(dir, 'anchor.sh');
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
SUDO=
REAL_GH=${realGh}
WRAP_PATH=${wrapper}
WRAP_MARKER='${GH_WRAPPER_MARKER}'
# 0) 幂等锚点${anchor}`,
      'utf8',
    );
    const before = statSync(wrapper).mtimeMs;
    const result = spawnSync('/bin/bash', [script], {
      env: { ...process.env, ZAG_GH_WRAPPER_SKIP_TOKEN: '1', GH_LOG: ghLog },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(statSync(wrapper).mtimeMs).toBe(before);
  });
});
