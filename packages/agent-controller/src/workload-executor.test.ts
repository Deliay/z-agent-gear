import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WorkloadExecutor,
  MAX_OUTPUT_BYTES,
  MAX_PENDING_RESULTS,
  EMPTY_SCRIPT_MESSAGE,
  type WorkloadResult,
} from './workload-executor.js';

const TMP_BASE = '/tmp/opencode';

function collect() {
  const results: WorkloadResult[] = [];
  return { results, sink: (result: WorkloadResult) => results.push(result) };
}

async function makeTmpDir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'we-'));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('WorkloadExecutor', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('T-WE1 runs items serially, merges stdout+stderr and reports success in item order', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'a', workloadName: 'A', script: 'echo out-a; echo err-a >&2', timeoutMs: 5000 },
          { logId: 'b', workloadName: 'B', script: 'echo out-b', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['a', 'b']);
    expect(results[0]).toMatchObject({ status: 'success', exitCode: 0 });
    expect(results[0].log).toContain('out-a');
    expect(results[0].log).toContain('err-a');
    expect(results[1]).toMatchObject({ status: 'success', exitCode: 0 });
    expect(results[1].log).toContain('out-b');
    expect(results[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(results[0].finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('T-WE2 reports failed with exitCode on non-zero exit and continues the batch', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'fail', workloadName: 'F', script: 'echo boom >&2; exit 3', timeoutMs: 5000 },
          { logId: 'ok', workloadName: 'O', script: 'echo ok', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results[0]).toMatchObject({ logId: 'fail', status: 'failed', exitCode: 3 });
    expect(results[0].log).toContain('boom');
    expect(results[1]).toMatchObject({ logId: 'ok', status: 'success' });
  });

  it('T-WE3 kills the whole process group on per-item timeout and continues', async () => {
    const dir = await makeTmpDir();
    dirs.push(dir);
    const marker = join(dir, 'leaked.txt');
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    const started = Date.now();
    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'slow', workloadName: 'S', script: `( sleep 1.5; echo leaked > ${marker} ) & sleep 30`, timeoutMs: 300 },
          { logId: 'next', workloadName: 'N', script: 'echo next', timeoutMs: 5000 },
        ],
      },
      sink,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    expect(results[0]).toMatchObject({ logId: 'slow', status: 'timeout', exitCode: null });
    expect(results[1]).toMatchObject({ logId: 'next', status: 'success' });

    // the backgrounded child would write the marker at 1.5s if the group was not killed
    await delay(2000);
    expect(await fileExists(marker)).toBe(false);
  }, 15000);

  it('T-WE4 truncates oversized output keeping the tail <= 256 KiB', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [{ logId: 'big', workloadName: 'Big', script: "yes A | head -c 300000; printf 'ENDMARK'", timeoutMs: 10000 }],
      },
      sink,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(Buffer.byteLength(results[0].log, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(results[0].log.endsWith('ENDMARK')).toBe(true);
  }, 15000);

  it('T-WE4b: skips a leading split UTF-8 continuation byte when truncating the tail', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    // 总长 262145 字节（3 字节「中」+ 262142 个 A），尾部保留 262144 字节 => 起点落在
    // 「中」的第 2 个字节（续字节）上；截断后必须跳过续字节到字符边界，首字符不得是乱码。
    await executor.runBatch(
      {
        phase: 'init',
        items: [
          {
            logId: 'utf8',
            workloadName: 'Utf8',
            script: "printf '中'; head -c 262142 /dev/zero | tr '\\0' 'A'",
            timeoutMs: 10000,
          },
        ],
      },
      sink,
    );

    expect(results).toHaveLength(1);
    const log = results[0].log;
    expect(log.includes('\uFFFD')).toBe(false);
    expect(log).toBe('A'.repeat(262142));
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  }, 15000);

  it('T-WE5 shares the post budget and reports timeout without starting later items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    const started = Date.now();
    await executor.runBatch(
      {
        phase: 'post',
        budgetMs: 300,
        items: [
          { logId: 'p1', workloadName: 'P1', script: 'sleep 2', timeoutMs: 10000 },
          { logId: 'p2', workloadName: 'P2', script: 'echo should-not-run', timeoutMs: 10000 },
        ],
      },
      sink,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    expect(results.map((r) => r.logId)).toEqual(['p1', 'p2']);
    expect(results[0]).toMatchObject({ status: 'timeout', exitCode: null });
    expect(results[1]).toMatchObject({ status: 'timeout', exitCode: null });
    expect(results[1].log).not.toContain('should-not-run');
  }, 15000);

  it('T-WE6 buffers unconfirmed results and replays then clears on reconnect', async () => {
    const executor = new WorkloadExecutor();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'r1', workloadName: 'R1', script: 'echo one', timeoutMs: 5000 },
          { logId: 'r2', workloadName: 'R2', script: 'echo two', timeoutMs: 5000 },
        ],
      },
      () => {},
    );

    expect(executor.getPendingResults().map((r) => r.logId)).toEqual(['r1', 'r2']);

    const replayed: WorkloadResult[] = [];
    executor.replayPendingResults((result) => replayed.push(result));

    expect(replayed.map((r) => r.logId)).toEqual(['r1', 'r2']);
    expect(executor.getPendingResults()).toHaveLength(0);
  });

  it('T-WE6b caps the replay buffer at 50 results', async () => {
    const executor = new WorkloadExecutor();
    const items = Array.from({ length: MAX_PENDING_RESULTS + 5 }, (_, i) => ({
      logId: `x${i}`,
      workloadName: `X${i}`,
      script: ':',
      timeoutMs: 5000,
    }));

    await executor.runBatch({ phase: 'init', items }, () => {});

    const pending = executor.getPendingResults();
    expect(pending).toHaveLength(MAX_PENDING_RESULTS);
    expect(pending[pending.length - 1].logId).toBe(`x${MAX_PENDING_RESULTS + 4}`);
  }, 30000);

  it('T-WE7 terminates the running init batch when a new post batch arrives', async () => {
    const dir = await makeTmpDir();
    dirs.push(dir);
    const startedFile = join(dir, 'init-started');
    const executor = new WorkloadExecutor();

    const initResults: WorkloadResult[] = [];
    const initBatch = executor.runBatch(
      {
        phase: 'init',
        items: [{ logId: 'init-1', workloadName: 'Init', script: `touch ${startedFile}; sleep 30`, timeoutMs: 60000 }],
      },
      (result) => initResults.push(result),
    );

    // wait until the init child process has actually started
    const deadline = Date.now() + 5000;
    let startedFlag = false;
    while (Date.now() < deadline) {
      if (await fileExists(startedFile)) {
        startedFlag = true;
        break;
      }
      await delay(25);
    }
    expect(startedFlag).toBe(true);

    const postResults: WorkloadResult[] = [];
    await executor.runBatch(
      { phase: 'post', items: [{ logId: 'post-1', workloadName: 'Post', script: 'echo post-ok', timeoutMs: 5000 }] },
      (result) => postResults.push(result),
    );
    await initBatch;

    expect(postResults.map((r) => r.logId)).toEqual(['post-1']);
    expect(postResults[0].status).toBe('success');
    // the interrupted init item is not reported; the server marks it TIMEOUT
    expect(initResults).toHaveLength(0);
  }, 20000);

  it('T-WE8 reports failed for an empty script and does nothing for empty items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      { phase: 'init', items: [{ logId: 'empty', workloadName: 'Empty', script: '   ', timeoutMs: 5000 }] },
      sink,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ logId: 'empty', status: 'failed', exitCode: null, log: EMPTY_SCRIPT_MESSAGE });

    const empty = collect();
    await executor.runBatch({ phase: 'init', items: [] }, empty.sink);
    expect(empty.results).toHaveLength(0);
  });

  it('T-WE10 injects TEXT/BOOLEAN params as WORKLOAD_PARAM_* and the full JSON as WORKLOAD_PARAMS', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          {
            logId: 'params',
            workloadName: 'Params',
            script: `printf 'P=%s\\n' "$WORKLOAD_PARAMS"; printf 'V=%s\\n' "$WORKLOAD_PARAM_VERSION"; printf 'D=%s\\n' "$WORKLOAD_PARAM_DEBUG"; printf 'E=%s\\n' "$WORKLOAD_PARAM_ENABLED"`,
            timeoutMs: 5000,
            workloadId: 'w-text',
            params: { version: '22', debug: true, enabled: false },
          },
        ],
      },
      sink,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].log).toContain('P={"version":"22","debug":true,"enabled":false}');
    expect(results[0].log).toContain('V=22');
    expect(results[0].log).toContain('D=true');
    expect(results[0].log).toContain('E=false');
  });

  it('T-WE11 injects MULTI_SELECT params as a JSON array string that scripts can parse', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          {
            logId: 'multi',
            workloadName: 'Multi',
            script: `printf 'PM=%s\\n' "$WORKLOAD_PARAM_PACKAGE_MANAGER"; node -e 'const v = JSON.parse(process.argv[1] || "[]"); process.stdout.write("parsed=" + v.join(","))' "$WORKLOAD_PARAM_PACKAGE_MANAGER"`,
            timeoutMs: 10000,
            workloadId: 'w-multi',
            params: { package_manager: ['pnpm', 'bun'] },
          },
        ],
      },
      sink,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].log).toContain('PM=["pnpm","bun"]');
    expect(results[0].log).toContain('parsed=pnpm,bun');
  }, 15000);

  it('T-WE12 keeps legacy behavior for empty params (only WORKLOAD_PARAMS={}, host env inherited)', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    process.env.ZAG_WORKLOAD_TEST_INHERITED = 'inherited';
    try {
      await executor.runBatch(
        {
          phase: 'init',
          items: [
            {
              logId: 'empty-params',
              workloadName: 'EmptyParams',
              script: `printf 'P=%s\\n' "$WORKLOAD_PARAMS"; printf 'FOO=%s\\n' "\${WORKLOAD_PARAM_FOO-unset}"; printf 'INHERIT=%s\\n' "\${ZAG_WORKLOAD_TEST_INHERITED-unset}"`,
              timeoutMs: 5000,
              workloadId: 'w-empty',
            },
          ],
        },
        sink,
      );
    } finally {
      delete process.env.ZAG_WORKLOAD_TEST_INHERITED;
    }

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(results[0].log).toContain('P={}');
    expect(results[0].log).toContain('FOO=unset');
    expect(results[0].log).toContain('INHERIT=inherited');
  });

  it('T-WE13 scopes params to the current item and does not leak them to later items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          {
            logId: 'first',
            workloadName: 'First',
            script: `printf 'P=%s\\n' "$WORKLOAD_PARAMS"`,
            timeoutMs: 5000,
            workloadId: 'w-first',
            params: { version: '22', package_manager: ['pnpm'] },
          },
          {
            logId: 'second',
            workloadName: 'Second',
            script: `printf 'P=%s\\n' "$WORKLOAD_PARAMS"; printf 'V=%s\\n' "\${WORKLOAD_PARAM_VERSION-unset}"; printf 'PM=%s\\n' "\${WORKLOAD_PARAM_PACKAGE_MANAGER-unset}"`,
            timeoutMs: 5000,
            workloadId: 'w-second',
          },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['first', 'second']);
    expect(results[0].log).toContain('P={"version":"22","package_manager":["pnpm"]}');
    expect(results[1].log).toContain('P={}');
    expect(results[1].log).toContain('V=unset');
    expect(results[1].log).toContain('PM=unset');
  });

  it('T-WE14 treats workloadId as log-only: order and result shape are unchanged', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'one', workloadName: 'One', workloadId: 'w-1', script: 'echo one', timeoutMs: 5000, params: { a: 'x' } },
          { logId: 'two', workloadName: 'Two', workloadId: 'w-2', script: 'echo two', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['one', 'two']);
    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
    expect(Object.keys(results[0]).sort()).toEqual(
      ['exitCode', 'finishedAt', 'log', 'logId', 'startedAt', 'status'].sort(),
    );
  });

  it('T-WE9 exposes running state and waitForIdle resolves after the batch completes', async () => {
    const executor = new WorkloadExecutor();
    expect(executor.isRunning()).toBe(false);

    const batch = executor.runBatch(
      { phase: 'post', items: [{ logId: 'w', workloadName: 'W', script: 'sleep 0.4', timeoutMs: 5000 }] },
      () => {},
    );
    expect(executor.isRunning()).toBe(true);

    await executor.waitForIdle(2000);
    expect(executor.isRunning()).toBe(false);
    await batch;
  }, 10000);
});

describe('WorkloadExecutor required short-circuit (T-WE-REQ)', () => {
  it('T-WE-REQ14: a required init item that fails stops subsequent items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'req', workloadName: 'Req', script: 'exit 3', timeoutMs: 5000, required: true },
          { logId: 'after', workloadName: 'After', script: 'echo should-not-run', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['req']);
    expect(results[0].status).toBe('failed');
    expect(results[0].exitCode).toBe(3);
  });

  it('T-WE-REQ15: a required item as the last item failing ends the batch normally', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'ok', workloadName: 'Ok', script: 'echo ok', timeoutMs: 5000 },
          { logId: 'req', workloadName: 'Req', script: 'exit 1', timeoutMs: 5000, required: true },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['ok', 'req']);
    expect(results.map((r) => r.status)).toEqual(['success', 'failed']);
  });

  it('T-WE-REQ16: a non-required failure continues subsequent items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'bad', workloadName: 'Bad', script: 'exit 2', timeoutMs: 5000, required: false },
          { logId: 'good', workloadName: 'Good', script: 'echo good', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['bad', 'good']);
    expect(results.map((r) => r.status)).toEqual(['failed', 'success']);
  });

  it('T-WE-REQ17: missing required field behaves exactly like the legacy executor', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'bad', workloadName: 'Bad', script: 'exit 1', timeoutMs: 5000 },
          { logId: 'good', workloadName: 'Good', script: 'echo good', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['bad', 'good']);
    expect(results.map((r) => r.status)).toEqual(['failed', 'success']);
  });

  it('T-WE-REQ18: a required post item failure does not short-circuit (post is never must)', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'post',
        items: [
          { logId: 'bad', workloadName: 'Bad', script: 'exit 1', timeoutMs: 5000, required: true },
          { logId: 'good', workloadName: 'Good', script: 'echo cleaned', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['bad', 'good']);
    expect(results.map((r) => r.status)).toEqual(['failed', 'success']);
  });

  it('T-WE-REQ14: a required init item timing out stops subsequent items', async () => {
    const executor = new WorkloadExecutor();
    const { results, sink } = collect();

    await executor.runBatch(
      {
        phase: 'init',
        items: [
          { logId: 'req', workloadName: 'Req', script: 'sleep 5', timeoutMs: 300, required: true },
          { logId: 'after', workloadName: 'After', script: 'echo should-not-run', timeoutMs: 5000 },
        ],
      },
      sink,
    );

    expect(results.map((r) => r.logId)).toEqual(['req']);
    expect(results[0].status).toBe('timeout');
  }, 10000);
});
