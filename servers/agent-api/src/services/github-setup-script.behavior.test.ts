import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_SETUP_SCRIPT } from './cloud-host-github-service.js';

const REPO = 'owner/repo';

interface ScriptResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface GhStub {
  binDir: string;
  logFile: string;
}

describe.skipIf(process.platform === 'win32')('Github 项目设置脚本行为（T-GHS1~14）', () => {
  let root: string;
  let target: string;
  let gh: GhStub;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zag-ghs-'));
    target = join(root, 'repo');
    gh = makeGhStub(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeGhStub(base: string): GhStub {
    const binDir = join(base, 'bin');
    const logFile = join(base, 'gh.log');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'gh');
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf \'%s\\n\' "$*" >> "$GH_STUB_LOG"',
        'mkdir -p "$4"',
        'printf \'cloned\\n\' > "$4/marker.txt"',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    return { binDir, logFile };
  }

  function runScript(pathOverride?: string): ScriptResult {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKLOAD_PARAM_TARGETPATH: target,
      WORKLOAD_PARAM_REPOFULLNAME: REPO,
      PATH: pathOverride ?? `${gh.binDir}:${process.env.PATH ?? ''}`,
      GH_STUB_LOG: gh.logFile,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
    };
    try {
      const stdout = execFileSync('/bin/bash', ['-c', GITHUB_SETUP_SCRIPT], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  function initRepo(origin: string): void {
    execFileSync('git', ['init', '-q', target]);
    execFileSync('git', ['-C', target, 'remote', 'add', 'origin', origin]);
  }

  function commitAll(): void {
    execFileSync('git', [
      '-C',
      target,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'init',
    ]);
  }

  function ghCalls(): string[] {
    if (!existsSync(gh.logFile)) return [];
    return readFileSync(gh.logFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function writeMarker(content = 'keep-me'): void {
    writeFileSync(join(target, 'marker.txt'), content);
  }

  it('T-GHS1: 目标不存在 → 调用 gh clone，exit 0', () => {
    const result = runScript();

    expect(result.status).toBe(0);
    expect(ghCalls()).toEqual([`repo clone ${REPO} ${target}`]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('cloned\n');
  });

  it('T-GHS2: 同仓库 https origin → 直接复用，不调用 gh，目录零改动', () => {
    initRepo('https://github.com/owner/repo.git');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('直接复用');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS3: 同仓库 ssh origin → 直接复用，不调用 gh', () => {
    initRepo('git@github.com:owner/repo.git');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('直接复用');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS4: 同仓库 + 本地 ahead 提交 → 不拉取，HEAD 与提交数不变', () => {
    initRepo('https://github.com/owner/repo.git');
    commitAll();
    commitAll();
    const headBefore = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const countBefore = execFileSync('git', ['-C', target, 'rev-list', '--count', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('直接复用');
    expect(ghCalls()).toEqual([]);
    expect(
      execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(headBefore);
    expect(
      execFileSync('git', ['-C', target, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(countBefore);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS5: 带凭据 origin → 归一后匹配，直接复用', () => {
    initRepo('https://x-access-token:abc@github.com/owner/repo.git');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('直接复用');
    expect(ghCalls()).toEqual([]);
  });

  it('T-GHS6: 异仓库 origin → exit 2 + 冲突文案，目录不变', () => {
    initRepo('https://github.com/owner/other.git');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS7: 前缀相似仓库 origin → exit 2，不误判为同仓库', () => {
    initRepo('https://github.com/owner/repo-2.git');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS8: 目标为空目录 → rmdir 后调用 gh clone', () => {
    mkdirSync(target);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(ghCalls()).toEqual([`repo clone ${REPO} ${target}`]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('cloned\n');
  });

  it('T-GHS9: 目标为非空普通目录 → exit 3 + 冲突文案，内容不变', () => {
    mkdirSync(target);
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS10: 目标为同名普通文件 → exit 4 + 冲突文案，文件不变', () => {
    writeFileSync(target, 'not-a-directory');

    const result = runScript();

    expect(result.status).toBe(4);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('not-a-directory');
  });

  it('T-GHS11: .git 存在但无 origin → exit 2，.git 保留', () => {
    execFileSync('git', ['init', '-q', target]);

    const result = runScript();

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it('T-GHS12: gh 不在 PATH → exit 1 + 安装提示', () => {
    const emptyBin = join(root, 'empty-bin');
    mkdirSync(emptyBin);

    const result = runScript(emptyBin);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('gh 不可用，请先安装 Github 工作负载');
    expect(existsSync(target)).toBe(false);
  });

  it('T-GHS13: .git 为普通文件 → exit 3 + 冲突文案，文件不变', () => {
    mkdirSync(target);
    writeFileSync(join(target, '.git'), 'gitdir: /somewhere/.git/worktrees/repo');
    writeMarker();

    const result = runScript();

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('目标目录已存在其他项目');
    expect(ghCalls()).toEqual([]);
    expect(readFileSync(join(target, '.git'), 'utf8')).toBe(
      'gitdir: /somewhere/.git/worktrees/repo',
    );
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('keep-me');
  });

  it('T-GHS14: 目标为指向空目录的符号链接 → 非零退出，链接与目标目录均保留', () => {
    const realDir = join(root, 'real-empty');
    mkdirSync(realDir);
    symlinkSync(realDir, target);

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(realDir)).toBe(true);
    expect(existsSync(join(realDir, 'marker.txt'))).toBe(false);
    expect(ghCalls()).toEqual([]);
  });
});
