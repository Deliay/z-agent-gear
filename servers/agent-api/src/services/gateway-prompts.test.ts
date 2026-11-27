import { describe, it, expect } from 'vitest';
import {
  GATEWAY_PROMPT_RESOURCES,
  GATEWAY_PROMPT_RESOURCE_URI_PREFIX,
  getGatewayPromptResource,
  listGatewayPromptNames,
} from './gateway-prompts.js';

/**
 * T-GP1~4：暴露指引防漂移守卫（计划 Phase 3 / 提案实现点 3）。
 * 指引正文的规则与实现同源，变更时必须同步修改本测试与实现。
 */
describe('gateway-prompts', () => {
  const resource = GATEWAY_PROMPT_RESOURCES[0];
  const text = getGatewayPromptResource(resource.uri)!.text;

  it('T-GP1: 单一资源、URI 前缀与 MIME 形态', () => {
    expect(GATEWAY_PROMPT_RESOURCES).toHaveLength(1);
    expect(resource.name).toBe('gateway-exposure-guidance');
    expect(resource.uri).toBe(
      'zag://agent-gateway-tools/prompt/gateway-exposure-guidance',
    );
    expect(resource.uri.startsWith(GATEWAY_PROMPT_RESOURCE_URI_PREFIX)).toBe(true);
    expect(resource.mimeType).toBe('text/markdown');
    expect(listGatewayPromptNames()).toEqual(['gateway-exposure-guidance']);
    expect(getGatewayPromptResource('zag://agent-gateway-tools/prompt/nope')).toBeNull();
  });

  it('T-GP2: 含 Vite base / allowedHosts / hmr: false 示例', () => {
    expect(text).toContain('vite.config.ts');
    expect(text).toContain('base:');
    expect(text).toContain('allowedHosts');
    expect(text).toContain('hmr: false');
    expect(text).toContain('WebSocket upgrade');
  });

  it('T-GP3: 覆盖访问限制（登录鉴权 / 30 秒 / 上限 5 / 命名规则）', () => {
    expect(text).toContain('登录');
    expect(text).toContain('401');
    expect(text).toContain('30 秒');
    expect(text).toContain('502');
    expect(text).toContain('最多 5 个端点');
    expect(text).toContain('[a-zA-Z0-9_-]{1,50}');
  });

  it('T-GP4: 明确禁止自行拼接地址（localhost/端口），并覆盖其他框架映射', () => {
    expect(text).toContain('禁止');
    expect(text).toContain('localhost');
    expect(text).toContain('Next.js');
    expect(text).toContain('Nuxt');
    expect(text).toContain('Spring');
    expect(text).toContain('gateway_delete_endpoint');
  });
});
