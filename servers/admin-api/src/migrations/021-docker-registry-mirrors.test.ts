import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source';
import { DOCKER_SCRIPT_V4 } from './012-worker-user-scripts';
import { DOCKER_SCRIPT_V5 } from './020-docker-shim-value-options';

const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./021-docker-registry-mirrors.js');
childSpy.mockRestore();

type MockDoc = {
  presetKey?: string | null;
  initScript?: string | null;
  paramSchema?: Array<Record<string, unknown>> | null;
  markModified?: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

const APT_PARAM = {
  key: 'docker_apt_url',
  label: 'Docker CE 软件源地址',
  type: 'text',
  options: [],
  defaultValue: 'https://nexus.internal.fffdan.com/repository/docker-ce-apt',
};

// ---------------------------------------------------------------------------
// bash 切片执行支撑：切出 V6 中的可测试标记段，写入临时脚本真跑
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function tmpDir(prefix = 'zag-mig021-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** 子进程 env：先剔除被测参数相关变量，再叠加用例声明的取值（undefined = 删除）。 */
function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DOCKER_REGISTRY_MIRRORS;
  delete env.WORKLOAD_PARAM_DOCKER_REGISTRY_MIRRORS;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runFile(
  file: string,
  opts: { env?: Record<string, string | undefined>; args?: string[] } = {},
): RunResult {
  const result = spawnSync('bash', [file, ...(opts.args ?? [])], {
    encoding: 'utf8',
    env: childEnv(opts.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runBash(
  source: string,
  opts: { env?: Record<string, string | undefined>; args?: string[] } = {},
): RunResult {
  const file = join(tmpDir(), 'slice.sh');
  writeFileSync(file, source);
  return runFile(file, opts);
}

/** 从 V6 脚本抽出固定注释标记包裹的纯逻辑段。 */
function section(begin: string, end: string): string {
  const script = migration.DOCKER_SCRIPT_V6 as string;
  const start = script.indexOf(begin);
  const stop = script.indexOf(end);
  expect(start, `begin marker ${begin} not found`).toBeGreaterThanOrEqual(0);
  expect(stop, `end marker ${end} not found`).toBeGreaterThan(start);
  return script.slice(start, stop + end.length);
}

const PARSE_BEGIN = '# [zag:mirrors-parse-begin]';
const PARSE_END = '# [zag:mirrors-parse-end]';
const JSON_BEGIN = '# [zag:mirrors-json-begin]';
const JSON_END = '# [zag:mirrors-json-end]';
const APPLY_BEGIN = '# [zag:mirrors-apply-begin]';
const APPLY_END = '# [zag:mirrors-apply-end]';

/** 解析段 + 打印结果：空数组输出 `__EMPTY__`，否则逐行输出地址。 */
function parseSlice(): string {
  return `${section(PARSE_BEGIN, PARSE_END)}
if [ "\${#REGISTRY_MIRRORS[@]}" -eq 0 ]; then
  echo "__EMPTY__"
else
  printf '%s\\n' "\${REGISTRY_MIRRORS[@]}"
fi
`;
}

describe('migration 021-docker-registry-mirrors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
    (CloudWorkload.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (CloudWorkload.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      _id: 'docker',
    });
  });

  function mockExistingDoc(overrides: Partial<MockDoc>): MockDoc {
    const doc: MockDoc = {
      presetKey: 'docker',
      initScript: DOCKER_SCRIPT_V4,
      paramSchema: [APT_PARAM],
      markModified: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    (CloudWorkload.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
    return doc;
  }

  // -------------------------------------------------------------------------
  // T-MIG-RM1~RM6：迁移名、刷新、幂等与定制保护
  // -------------------------------------------------------------------------

  it('T-MIG-RM1: exposes the migration name', () => {
    expect(migration.name).toBe('021-docker-registry-mirrors');
  });

  it('T-MIG-RM2: refreshes a v4 script to v6 and appends the mirrors param', async () => {
    const doc = mockExistingDoc({ initScript: DOCKER_SCRIPT_V4 });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V6);
    expect(doc.markModified).toHaveBeenCalledWith('initScript');
    expect(doc.paramSchema).toHaveLength(2);
    expect(doc.paramSchema?.[0]).toEqual(APT_PARAM);
    expect(doc.paramSchema?.[1]).toMatchObject({
      key: 'docker_registry_mirrors',
      label: '镜像仓库镜像地址',
      type: 'text',
      defaultValue: migration.DOCKER_REGISTRY_MIRRORS_DEFAULT,
    });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it.each([
    ['v1', DOCKER_SCRIPT_V1],
    ['v2', DOCKER_SCRIPT_V2],
    ['v3', DOCKER_SCRIPT_V3],
    ['v5', DOCKER_SCRIPT_V5],
  ])('T-MIG-RM3: refreshes an unmodified %s docker script to v6', async (_label, script) => {
    const doc = mockExistingDoc({ initScript: script });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V6);
    expect(doc.paramSchema).toHaveLength(2);
    expect(doc.paramSchema?.[1]?.key).toBe('docker_registry_mirrors');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG-RM4: is idempotent when the script is v6 and the param exists', async () => {
    const doc = mockExistingDoc({
      initScript: migration.DOCKER_SCRIPT_V6,
      paramSchema: [APT_PARAM, { key: 'docker_registry_mirrors', defaultValue: 'custom' }],
    });
    const before = { ...doc.paramSchema?.[1] };

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V6);
    expect(doc.paramSchema).toHaveLength(2);
    expect(doc.paramSchema?.[1]).toEqual(before);
    expect(doc.save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG-RM5: appends only the missing param on an already-v6 script', async () => {
    const doc = mockExistingDoc({
      initScript: migration.DOCKER_SCRIPT_V6,
      paramSchema: [APT_PARAM],
    });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V6);
    expect(doc.paramSchema).toHaveLength(2);
    expect(doc.paramSchema?.[1]).toMatchObject({
      key: 'docker_registry_mirrors',
      defaultValue: migration.DOCKER_REGISTRY_MIRRORS_DEFAULT,
    });
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('T-MIG-RM6: never overwrites an admin-customized script nor adds params', async () => {
    const custom = '#!/usr/bin/env bash\necho my-custom-docker-setup\n';
    const doc = mockExistingDoc({ initScript: custom, paramSchema: [APT_PARAM] });

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(doc.paramSchema).toEqual([APT_PARAM]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM7a/7b：缺失预置项不重建
  // -------------------------------------------------------------------------

  it('T-MIG-RM7a: skips (without recreating) when only the exact name matches', async () => {
    const byName = mockExistingDoc({ presetKey: null });
    (CloudWorkload.findOne as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(byName);

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(byName.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-RM7b: does not recreate a preset deleted by an admin', async () => {
    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM8：脚本不变量 + bash -n
  // -------------------------------------------------------------------------

  it('T-MIG-RM8: V6 keeps the runtime invariants and drops every shim trace', () => {
    const script = migration.DOCKER_SCRIPT_V6 as string;

    expect(script).toContain('registry-mirrors');
    expect(script).toContain('/etc/docker/daemon.json');
    expect(script).toContain('docker info --format');
    expect(script).toContain('pkill');
    expect(script).toContain('dockerd -G worker');
    expect(script).toContain('[zag:mirrors-parse-begin]');
    expect(script).toContain('[zag:mirrors-apply-end]');

    expect(script).not.toContain('normalize_image');
    expect(script).not.toContain('HARBOR_PROXY');
    expect(script).not.toContain('SHIM_PATH');
    expect(script).not.toContain('ZAG_DOCKER_SHIM_PATH');
    expect(script).not.toContain("<<'SHIM'");

    // 历史版本常量只读：V5 仍是完整的 shim 版本，未被 021 改写
    expect(DOCKER_SCRIPT_V5).toContain('normalize_image');
    expect(DOCKER_SCRIPT_V5).toContain("<<'SHIM'");

    const file = join(tmpDir(), 'docker-v6.sh');
    writeFileSync(file, script);
    expect(() => execFileSync('bash', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM9：地址解析切片
  // -------------------------------------------------------------------------

  it('T-MIG-RM9: resolves mirrors from env > param with split/trim/validation', () => {
    const source = parseSlice();

    // env 覆盖参数，并去掉尾部斜杠
    const overridden = runBash(source, {
      env: {
        DOCKER_REGISTRY_MIRRORS: 'https://a.example/',
        WORKLOAD_PARAM_DOCKER_REGISTRY_MIRRORS: 'https://b.example',
      },
    });
    expect(overridden.status).toBe(0);
    expect(overridden.stdout.trim().split('\n')).toEqual(['https://a.example']);

    // env 显式为空 = 清空（覆盖参数）
    const cleared = runBash(source, {
      env: {
        DOCKER_REGISTRY_MIRRORS: '',
        WORKLOAD_PARAM_DOCKER_REGISTRY_MIRRORS: 'https://b.example',
      },
    });
    expect(cleared.status).toBe(0);
    expect(cleared.stdout.trim()).toBe('__EMPTY__');

    // 参数注入回退
    const fromParam = runBash(source, {
      env: { WORKLOAD_PARAM_DOCKER_REGISTRY_MIRRORS: 'https://p.example' },
    });
    expect(fromParam.status).toBe(0);
    expect(fromParam.stdout.trim().split('\n')).toEqual(['https://p.example']);

    // 逗号切分 / trim / 空段丢弃 / 尾斜杠去除
    const split = runBash(source, {
      env: {
        DOCKER_REGISTRY_MIRRORS: '  https://a.example/ ,, https://b.example\t,',
      },
    });
    expect(split.status).toBe(0);
    expect(split.stdout.trim().split('\n')).toEqual(['https://a.example', 'https://b.example']);

    // 全空（未设置）
    expect(runBash(source).stdout.trim()).toBe('__EMPTY__');
    // 仅空白 / 仅逗号
    expect(runBash(source, { env: { DOCKER_REGISTRY_MIRRORS: '   ' } }).stdout.trim()).toBe(
      '__EMPTY__',
    );
    expect(runBash(source, { env: { DOCKER_REGISTRY_MIRRORS: ' , , ' } }).stdout.trim()).toBe(
      '__EMPTY__',
    );

    // 非 http(s) 前缀 → exit 2
    const badScheme = runBash(source, { env: { DOCKER_REGISTRY_MIRRORS: 'ftp://a.example' } });
    expect(badScheme.status).toBe(2);
    expect(badScheme.stderr).toContain('镜像仓库镜像地址非法');

    // 含双引号 → exit 2
    const quoted = runBash(source, {
      env: { DOCKER_REGISTRY_MIRRORS: 'https://a.example/x"y' },
    });
    expect(quoted.status).toBe(2);
    expect(quoted.stderr).toContain('非法字符');

    // 含反斜杠 → exit 2
    const slashed = runBash(source, {
      env: { DOCKER_REGISTRY_MIRRORS: 'https://a.example/x\\y' },
    });
    expect(slashed.status).toBe(2);
    expect(slashed.stderr).toContain('非法字符');

    // 含内部空白 → exit 2
    const spaced = runBash(source, {
      env: { DOCKER_REGISTRY_MIRRORS: 'https://a.example/x y' },
    });
    expect(spaced.status).toBe(2);
    expect(spaced.stderr).toContain('非法字符');
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM10：JSON 生成与归属判定
  // -------------------------------------------------------------------------

  it('T-MIG-RM10: renders compact json and detects script-managed daemon.json', () => {
    const source = `SUDO=
${section(JSON_BEGIN, JSON_END)}
if [ "$1" = "render" ]; then
  shift
  render_registry_mirrors_json "$@"
elif is_managed_daemon_json "$1"; then
  echo "MANAGED"
else
  echo "NOT_MANAGED"
fi
`;

    const rendered = runBash(source, {
      args: ['render', 'a.example', 'https://b.example'],
    });
    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toBe('{"registry-mirrors":["a.example","https://b.example"]}');

    const dir = tmpDir();
    const sketch = join(dir, 'sketch.json');
    writeFileSync(sketch, '{\n  "registry-mirrors": ["https://a.example"]\n}\n');
    expect(runBash(source, { args: [sketch] }).stdout.trim()).toBe('MANAGED');

    const other = join(dir, 'other.json');
    writeFileSync(other, '{"debug":true}');
    expect(runBash(source, { args: [other] }).stdout.trim()).toBe('NOT_MANAGED');

    const mixed = join(dir, 'mixed.json');
    writeFileSync(mixed, '{"registry-mirrors":["https://a.example"],"debug":true}');
    expect(runBash(source, { args: [mixed] }).stdout.trim()).toBe('NOT_MANAGED');

    const missing = join(dir, 'missing.json');
    expect(runBash(source, { args: [missing] }).stdout.trim()).toBe('NOT_MANAGED');
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM11：daemon.json 落盘行为切片
  // -------------------------------------------------------------------------

  it('T-MIG-RM11: writes / overwrites / backs up / removes daemon.json idempotently', () => {
    const runApply = (options: {
      mirrors?: string;
      existing?: { name: string; content: string } | null;
    }): RunResult & { entries: string[]; file: string; changed: string; removed: string } => {
      const dir = tmpDir();
      const daemonJson = join(dir, 'daemon.json');
      if (options.existing) writeFileSync(join(dir, options.existing.name), options.existing.content);

      const source = `${section(PARSE_BEGIN, PARSE_END)}
${section(JSON_BEGIN, JSON_END)}
${section(APPLY_BEGIN, APPLY_END)
  .replace('DAEMON_JSON=/etc/docker/daemon.json', `DAEMON_JSON=${daemonJson}`)
  .replace('${SUDO} mkdir -p /etc/docker', '${SUDO} mkdir -p "$(dirname "$DAEMON_JSON")"')}
echo "CHANGED=\${DAEMON_CHANGED}"
echo "REMOVED=\${DAEMON_MANAGED_REMOVED}"
if [ -e "$DAEMON_JSON" ]; then
  echo "FILE=$(tr -d '[:space:]' < "$DAEMON_JSON")"
else
  echo "FILE=ABSENT"
fi
for f in "$DAEMON_JSON"*; do
  [ -e "$f" ] || continue
  echo "ENTRY=$(basename "$f")"
done
`;
      const result = runBash(source, { env: { DOCKER_REGISTRY_MIRRORS: options.mirrors ?? '' } });
      const lines = result.stdout.split('\n').filter((line) => line !== '');
      const pick = (prefix: string) =>
        lines.find((line) => line.startsWith(prefix))?.slice(prefix.length + 1) ?? '';
      return {
        ...result,
        changed: pick('CHANGED'),
        removed: pick('REMOVED'),
        file: pick('FILE'),
        entries: lines
          .filter((line) => line.startsWith('ENTRY='))
          .map((line) => line.slice('ENTRY='.length)),
      };
    };

    const target = '{"registry-mirrors":["https://a.example"]}';

    // 1) 文件不存在 → 写入
    const created = runApply({ mirrors: 'https://a.example' });
    expect(created.status).toBe(0);
    expect(created.changed).toBe('1');
    expect(created.file).toBe(target);
    expect(created.entries).toEqual(['daemon.json']);

    // 2) 脚本管理且一致 → 幂等不写
    const unchanged = runApply({
      mirrors: 'https://a.example',
      existing: { name: 'daemon.json', content: '{\n  "registry-mirrors": ["https://a.example"]\n}' },
    });
    expect(unchanged.status).toBe(0);
    expect(unchanged.changed).toBe('0');
    expect(unchanged.entries).toEqual(['daemon.json']);

    // 3) 脚本管理但不一致 → 覆写（不备份）
    const rewritten = runApply({
      mirrors: 'https://a.example',
      existing: { name: 'daemon.json', content: '{"registry-mirrors":["https://old.example"]}' },
    });
    expect(rewritten.status).toBe(0);
    expect(rewritten.changed).toBe('1');
    expect(rewritten.file).toBe(target);
    expect(rewritten.entries).toEqual(['daemon.json']);

    // 4) 环境自管 → 备份 + 覆写
    const backedUp = runApply({
      mirrors: 'https://a.example',
      existing: { name: 'daemon.json', content: '{"debug":true}' },
    });
    expect(backedUp.status).toBe(0);
    expect(backedUp.changed).toBe('1');
    expect(backedUp.file).toBe(target);
    expect(backedUp.entries).toHaveLength(2);
    expect(backedUp.entries).toContain('daemon.json');
    expect(backedUp.entries.some((entry) => entry.startsWith('daemon.json.pre-zag-'))).toBe(true);
    expect(backedUp.stderr).toContain('警告');

    // 5) 空地址 + 脚本管理文件 → 删除
    const removed = runApply({
      mirrors: '',
      existing: { name: 'daemon.json', content: '{"registry-mirrors":["https://a.example"]}' },
    });
    expect(removed.status).toBe(0);
    expect(removed.changed).toBe('1');
    expect(removed.removed).toBe('1');
    expect(removed.file).toBe('ABSENT');
    expect(removed.entries).toEqual([]);
    expect(removed.stdout).toContain('未配置镜像加速');

    // 6) 空地址 + 环境自管文件 → 保留 + 告警
    const preserved = runApply({
      mirrors: '',
      existing: { name: 'daemon.json', content: '{"debug":true}' },
    });
    expect(preserved.status).toBe(0);
    expect(preserved.changed).toBe('0');
    expect(preserved.removed).toBe('0');
    expect(preserved.file).toBe('{"debug":true}');
    expect(preserved.entries).toEqual(['daemon.json']);
    expect(preserved.stderr).toContain('警告');
  });

  // -------------------------------------------------------------------------
  // T-MIG-RM12：历史 shim 清理切片
  // -------------------------------------------------------------------------

  it('T-MIG-RM12: removes only platform legacy shims', () => {
    const dir = tmpDir();
    const shimPath = join(dir, 'docker');
    const source = `SUDO=
${section(PARSE_BEGIN, JSON_END).replace(
      'LEGACY_SHIM="/usr/local/bin/docker"',
      `LEGACY_SHIM="${shimPath}"`,
    )}
if [ -e "$LEGACY_SHIM" ]; then echo "EXISTS"; else echo "ABSENT"; fi
`;

    // 含平台标记 → 删除
    writeFileSync(
      shimPath,
      '#!/usr/bin/env bash\nHARBOR_PROXY="core.harbor.internal.fffdan.com"\nnormalize_image() { :; }\n',
    );
    const removed = runBash(source);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain('ABSENT');
    expect(removed.stdout).toContain('已清理历史镜像引用规范化 shim');

    // 无平台标记 → 保留 + 告警
    writeFileSync(shimPath, '#!/usr/bin/env bash\necho somebody-elses-wrapper\n');
    const preserved = runBash(source);
    expect(preserved.status).toBe(0);
    expect(preserved.stdout).toContain('EXISTS');
    expect(preserved.stdout).not.toContain('已清理历史镜像引用规范化 shim');
    expect(preserved.stderr).toContain('保留不动');

    // 不存在 → 无操作
    rmSync(shimPath, { force: true });
    const absent = runBash(source);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toContain('ABSENT');
    expect(absent.stdout).not.toContain('已清理历史镜像引用规范化 shim');
    expect(absent.stderr).toBe('');
  });
});
