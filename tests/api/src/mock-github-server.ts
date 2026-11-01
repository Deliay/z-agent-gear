import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * 进程内 mock GitHub（Check Runs 出站验证）。
 *
 * 覆盖 agent-api Check Runs 同步链路用到的三条路由：
 * - `POST /app/installations/:id/access_tokens`（签发假 installation token）
 * - `POST /repos/:owner/:repo/check-runs`（创建）
 * - `PATCH /repos/:owner/:repo/check-runs/:id`（更新）
 * - `GET /repos/:owner/:repo/pulls/:n`（PR 最新 head / state / merged）
 *
 * 真实对端约束：GitHub 只允许 GitHub 自己把 `conclusion` 置为 `stale`
 * （应用侧 POST/PATCH `conclusion=stale` 返回 422），mock 必须同样拒绝，
 * 否则会放过「依赖 GitHub 禁止能力」的实现（controller-api/AGENTS.md 跨服务协议教训）。
 *
 * 记录全部调用，支持 `failNext(status)` 注入失败、`setHead`/`setPullRequestState` 改状态。
 */
export interface MockGitHubCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

export interface MockCheckRun {
  id: number;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  output: Record<string, unknown> | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface MockGitHubServer {
  url: string;
  port: number;
  calls: MockGitHubCall[];
  checkRuns: MockCheckRun[];
  setHead(sha: string): void;
  setPullRequestState(state: string, merged?: boolean): void;
  failNext(status: number, times?: number): void;
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startMockGitHubServer(options?: {
  port?: number;
  headSha?: string;
  /** Commit 提交身份测试：`GET /users/{slug}[bot]` 返回的 bot 用户 id。 */
  botUserId?: number;
}): Promise<MockGitHubServer> {
  const calls: MockGitHubCall[] = [];
  const checkRuns: MockCheckRun[] = [];
  let nextId = 1000;
  let headSha = options?.headSha ?? 'sha-head-1';
  let state = 'open';
  let merged = false;
  const failures: number[] = [];

  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    let parsed: Record<string, unknown> | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    calls.push({ method, path: url, headers: req.headers, body: parsed });

    if (failures.length > 0) {
      json(res, failures.shift() as number, { message: 'injected failure' });
      return;
    }

    // App bot identity（Commit 提交身份：GET /app → slug，GET /users/{slug}[bot] → id）
    if (method === 'GET' && url === '/app') {
      json(res, 200, { slug: 'zag-test-bot' });
      return;
    }
    const decodedUrl = decodeURIComponent(url);
    const botMatch = /^\/users\/([^/]+)\[bot\]$/.exec(decodedUrl);
    if (method === 'GET' && botMatch) {
      json(res, 200, { id: options?.botUserId ?? 424242, login: botMatch[1] });
      return;
    }

    // installation token
    if (method === 'POST' && /^\/app\/installations\/[^/]+\/access_tokens$/.test(url)) {
      json(res, 201, {
        token: 'mock-installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return;
    }

    // installation account（GitHub App setup：/app/installations/:id）
    if (method === 'GET' && /^\/app\/installations\/[^/]+$/.test(url)) {
      json(res, 200, {
        id: Number(url.split('/').pop()),
        account: {
          id: 9001,
          login: 'octo-org',
          avatar_url: 'https://avatars.mock/9001',
          type: 'Organization',
        },
      });
      return;
    }

    // installation repositories（installation token 鉴权）
    if (method === 'GET' && url === '/installation/repositories') {
      json(res, 200, {
        total_count: 1,
        repositories: [
          {
            id: 7001,
            name: 'demo',
            full_name: 'octo-org/demo',
            private: false,
            permissions: { admin: true, push: true, pull: true },
          },
        ],
      });
      return;
    }

    // pull request head
    const pullMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url);
    if (method === 'GET' && pullMatch) {
      json(res, 200, { head: { sha: headSha }, state, merged });
      return;
    }

    // create check-run
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/check-runs$/.test(url)) {
      const body = parsed ?? {};
      if (body.conclusion === 'stale') {
        json(res, 422, {
          message: 'You cannot change a check run conclusion to stale, only GitHub can set this.',
        });
        return;
      }
      const now = new Date().toISOString();
      const checkRun: MockCheckRun = {
        id: nextId++,
        name: String(body.name ?? ''),
        head_sha: String(body.head_sha ?? ''),
        external_id: typeof body.external_id === 'string' ? body.external_id : null,
        status: String(body.status ?? 'queued'),
        conclusion: typeof body.conclusion === 'string' ? body.conclusion : null,
        output: (body.output as Record<string, unknown>) ?? null,
        html_url: `https://github.mock/runs/${nextId}`,
        created_at: now,
        updated_at: now,
      };
      checkRuns.push(checkRun);
      json(res, 201, checkRun);
      return;
    }

    // update check-run
    const updateMatch = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(url);
    if (method === 'PATCH' && updateMatch) {
      const target = checkRuns.find((run) => run.id === Number(updateMatch[1]));
      if (!target) {
        json(res, 404, { message: 'not found' });
        return;
      }
      const body = parsed ?? {};
      if (body.conclusion === 'stale') {
        json(res, 422, {
          message: 'You cannot change a check run conclusion to stale, only GitHub can set this.',
        });
        return;
      }
      if (typeof body.status === 'string') target.status = body.status;
      if (typeof body.conclusion === 'string') target.conclusion = body.conclusion;
      if (body.output && typeof body.output === 'object') {
        target.output = body.output as Record<string, unknown>;
      }
      target.updated_at = new Date().toISOString();
      json(res, 200, target);
      return;
    }

    json(res, 404, { message: 'not found' });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options?.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('mock github server failed to bind'));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    checkRuns,
    setHead(sha: string) {
      headSha = sha;
    },
    setPullRequestState(nextState: string, nextMerged = false) {
      state = nextState;
      merged = nextMerged;
    },
    failNext(status: number, times = 1) {
      for (let i = 0; i < times; i += 1) failures.push(status);
    },
    reset() {
      calls.length = 0;
      checkRuns.length = 0;
      failures.length = 0;
      state = 'open';
      merged = false;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
