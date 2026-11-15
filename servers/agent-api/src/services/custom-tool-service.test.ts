import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CustomTool } from '../models/custom-tool.js';
import {
  customToolService,
  validateCustomToolInput,
  type CustomToolInput,
  type CustomToolHttpConfigInput,
} from './custom-tool-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';
import type { Fragment } from './fragment-render.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-custom-tool-service-test'));
  await CustomTool.init();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.collection('customtools').deleteMany({});
});

const TENANT = '507f1f77bcf86cd7994390a1';
const WS_A = '507f1f77bcf86cd7994390b1';
const WS_B = '507f1f77bcf86cd7994390b2';
const WS_GLOBAL = '507f1f77bcf86cd7994390b3';
const USER = '507f1f77bcf86cd7994390c1';

const ctxA: WorkspaceContext = {
  id: WS_A,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const ctxB: WorkspaceContext = { ...ctxA, id: WS_B };
const ctxGlobalDev: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'developer',
  readOnly: true,
  globalWorkspaceId: WS_GLOBAL,
};

function f(type: Fragment['type'], value: string, format: Fragment['format'] = 'Generic'): Fragment {
  return { type, value, format };
}

function promptInput(overrides: Partial<CustomToolInput> = {}): CustomToolInput {
  return {
    name: '查询天气',
    type: 'prompt',
    args: [
      { key: 'city', name: '目标城市' },
      { key: 'month', name: '月份' },
    ],
    prompt: [f('Plain', 'https://foo.bar/'), f('Parameter', 'city'), f('Plain', '/weather/'), f('Parameter', 'month')],
    ...overrides,
  };
}

function httpInput(overrides: Partial<CustomToolHttpConfigInput> = {}): CustomToolHttpConfigInput {
  return {
    method: 'POST',
    endpoint: [f('Plain', 'https://api.example.com/v1/')],
    headers: [{ key: 'X-Token', value: [f('Valut', 'API_TOKEN')] }],
    queries: [{ key: 'q', value: [f('Parameter', 'city', 'Uri')] }],
    bodyType: 'json',
    body: [f('Plain', '{"city":'), f('Parameter', 'city', 'Json'), f('Plain', '}')],
    ...overrides,
  };
}

function createParams(input: CustomToolInput) {
  return {
    name: input.name as string,
    description: input.description,
    type: 'prompt' as const,
    args: (input.args ?? []) as never,
    prompt: input.prompt as never,
    http: null,
    createdBy: USER,
  };
}

async function createPrompt(overrides: Partial<CustomToolInput> = {}) {
  return runWithWorkspace(ctxA, () => customToolService.create(createParams(promptInput(overrides))));
}

describe('custom-tool-service（T-CTS / T-CTS4，真库）', () => {
  it('CRUD 全链路：创建/列表/单条/更新/删除', async () => {
    const created = await createPrompt();
    expect(created.id).toBeTruthy();
    expect(created.type).toBe('prompt');
    expect(created.prompt?.map((part) => part.type)).toEqual([
      'Plain',
      'Parameter',
      'Plain',
      'Parameter',
    ]);
    expect(created.http).toBeNull();

    await runWithWorkspace(ctxA, async () => {
      const list = await customToolService.list();
      expect(list.map((tool) => tool.name)).toEqual(['查询天气']);
      await expect(customToolService.get(created.id)).resolves.toMatchObject({ id: created.id });
    });

    const updated = await runWithWorkspace(ctxA, () =>
      customToolService.update(created.id, { name: '查询天气 v2', args: [{ key: 'city', name: '城市' }], prompt: [f('Parameter', 'city')] }),
    );
    expect(updated.name).toBe('查询天气 v2');
    expect(updated.args).toHaveLength(1);

    await expect(runWithWorkspace(ctxA, () => customToolService.delete(created.id))).resolves.toBe(
      true,
    );
    await expect(runWithWorkspace(ctxA, () => customToolService.get(created.id))).resolves.toBeNull();
  });

  it('T-CTS1：name/description/args/模板校验逐字白名单', async () => {
    const cases: Array<[Partial<CustomToolInput>, string]> = [
      [{ name: '' }, 'invalid custom tool name'],
      [{ name: 'x'.repeat(65) }, 'invalid custom tool name'],
      [{ description: 'x'.repeat(513) }, 'invalid custom tool description'],
      [{ args: [{ key: '1bad', name: 'n' }] }, 'invalid custom tool args'],
      [{ args: [{ key: 'a', name: '' }] }, 'invalid custom tool args'],
      [{ args: [{ key: 'a', name: 'n', description: 'x'.repeat(257) }] }, 'invalid custom tool args'],
      [
        { args: Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, name: 'n' })) },
        'invalid custom tool args',
      ],
      [{ args: [{ key: 'a', name: 'n' }, { key: 'a', name: 'm' }] }, 'invalid custom tool args'],
      [{ prompt: [{ type: 'Nope' as never, value: 'x', format: 'Generic' }] }, 'invalid fragment template'],
      [{ prompt: [] }, 'invalid fragment template'],
    ];
    for (const [override, message] of cases) {
      await expect(createPrompt(override)).rejects.toThrow(message);
    }
  });

  it('T-CTS2：引用一致性（未声明参数 / 非法 valut key）→ invalid fragment template', async () => {
    await expect(
      createPrompt({ prompt: [f('Parameter', 'unknown')] }),
    ).rejects.toThrow('invalid fragment template');
    await expect(
      createPrompt({ prompt: [f('Valut', 'bad key')] }),
    ).rejects.toThrow('invalid fragment template');
    await expect(
      createPrompt({ prompt: [f('Valut', 'x'.repeat(129))] }),
    ).rejects.toThrow('invalid fragment template');
    await expect(createPrompt({ prompt: [f('Valut', 'OK_KEY')] })).resolves.toMatchObject({
      type: 'prompt',
    });
  });

  it('T-CTS3：http 校验矩阵（method/endpoint/header/GET body/file）', async () => {
    const cases: Array<[CustomToolHttpConfigInput, string]> = [
      [httpInput({ method: 'BAD METHOD' }), 'invalid http config'],
      [httpInput({ endpoint: [f('Valut', 'X')] }), 'invalid http config'],
      [httpInput({ endpoint: [f('Plain', 'ftp://x')] }), 'invalid http config'],
      [httpInput({ endpoint: [] }), 'invalid http config'],
      [httpInput({ headers: [{ key: 'bad key', value: [f('Plain', 'x')] }] }), 'invalid http config'],
      [
        httpInput({
          headers: [
            { key: 'Cookie', value: [f('Plain', 'a')] },
            { key: 'cookie', value: [f('Plain', 'b')] },
          ],
        }),
        'invalid http config',
      ],
      [httpInput({ method: 'GET' }), 'invalid http config'],
      [httpInput({ bodyType: 'form', form: [{ key: 'f', type: 'file', value: [f('Plain', 'x')] }] }), 'invalid http config'],
      [httpInput({ queries: [{ key: 'bad key', value: [f('Plain', 'x')] }] }), 'invalid http config'],
    ];
    for (const [http, message] of cases) {
      await expect(
        runWithWorkspace(ctxA, () =>
          customToolService.create({
            name: `http-${Math.random()}`,
            type: 'http',
            args: [{ key: 'city', name: '城市' }],
            http,
            createdBy: USER,
          }),
        ),
      ).rejects.toThrow(message);
    }

    await expect(
      runWithWorkspace(ctxA, () =>
        customToolService.create({
          name: 'http-ok',
          type: 'http',
          args: [{ key: 'city', name: '城市' }],
          http: httpInput(),
          createdBy: USER,
        }),
      ),
    ).resolves.toMatchObject({ type: 'http', prompt: null });
  });

  it('T-CTS5：重名两道防线 → duplicate custom tool name', async () => {
    await createPrompt();
    await expect(createPrompt()).rejects.toThrow('duplicate custom tool name');
  });

  it('T-CTS4：权限矩阵（全局 developer 写拒 / 普通工作区读写通 / 跨工作区 Not found）', async () => {
    await expect(
      runWithWorkspace(ctxGlobalDev, () =>
        customToolService.create(createParams(promptInput())),
      ),
    ).rejects.toThrow('global workspace is read-only');

    const created = await createPrompt();
    await expect(
      runWithWorkspace(ctxGlobalDev, () => customToolService.list()),
    ).resolves.toEqual([]);
    await expect(
      runWithWorkspace(ctxGlobalDev, () => customToolService.delete(created.id)),
    ).rejects.toThrow('global workspace is read-only');

    await expect(
      runWithWorkspace(ctxB, () => customToolService.get(created.id)),
    ).rejects.toThrow('Not found');
    await expect(
      runWithWorkspace(ctxB, () => customToolService.delete(created.id)),
    ).rejects.toThrow('Not found');
  });

  it('不存在 id → custom tool not found；非法 id 同口径；无上下文 → workspace not found', async () => {
    await expect(
      runWithWorkspace(ctxA, () => customToolService.delete('507f1f77bcf86cd799439999')),
    ).rejects.toThrow('custom tool not found');
    await expect(
      runWithWorkspace(ctxA, () => customToolService.delete('not-an-id')),
    ).rejects.toThrow('custom tool not found');
    await expect(customToolService.list()).rejects.toThrow('workspace not found');
  });

  it('validateCustomToolInput 纯函数：prompt 与 http 互斥字段归一', () => {
    const prompt = validateCustomToolInput('prompt', promptInput());
    expect(prompt.http).toBeNull();
    expect(prompt.prompt?.length).toBeGreaterThan(0);

    const http = validateCustomToolInput('http', {
      name: 'h',
      args: [{ key: 'city', name: '城市' }],
      type: 'http',
      http: httpInput(),
    });
    expect(http.prompt).toBeNull();
    expect(http.http?.bodyType).toBe('json');
  });
});
