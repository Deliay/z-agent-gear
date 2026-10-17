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
