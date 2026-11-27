import { describe, it, expect } from 'vitest';
import {
  buildGatewayBasePath,
  buildGatewayEndpoint,
  normalizeGatewayBaseUrl,
} from './gateway-endpoint.js';

/**
 * T-GWE1~6：endpoint/basePath 纯函数（PRD 功能点 1/3、提案 §3.2、计划 Phase 1）。
 * `PUBLIC_BASE_URL` 是 endpoint 的单一事实源，任何地方不得二次拼接。
 */
describe('gateway-endpoint', () => {
  it('T-GWE1: publicBaseUrl 尾斜杠归一（单/多斜杠均等价）', () => {
    expect(normalizeGatewayBaseUrl('https://host/')).toBe('https://host');
    expect(normalizeGatewayBaseUrl('https://host///')).toBe('https://host');
    expect(normalizeGatewayBaseUrl('https://host')).toBe('https://host');
    expect(buildGatewayEndpoint('https://host/', 'ctrl1', 'svc')).toBe(
      buildGatewayEndpoint('https://host', 'ctrl1', 'svc'),
    );
  });

  it('T-GWE2: controllerId / name 走路径段编码', () => {
    expect(buildGatewayBasePath('ctrl 1', 'my service')).toBe(
      '/api/gateway/ctrl%201/my%20service/',
    );
    expect(buildGatewayEndpoint('https://host', 'ctrl/1', 'a?b')).toBe(
      'https://host/api/gateway/ctrl%2F1/a%3Fb/',
    );
  });

  it('T-GWE3: basePath 恒以 / 开头与结尾', () => {
    const basePath = buildGatewayBasePath('66f1', 'my-service');
    expect(basePath).toBe('/api/gateway/66f1/my-service/');
    expect(basePath.startsWith('/')).toBe(true);
    expect(basePath.endsWith('/')).toBe(true);
  });

  it('T-GWE4: endpoint = publicBaseUrl + basePath（无重复/缺失斜杠）', () => {
    const endpoint = buildGatewayEndpoint('https://host', 'ctrl1', 'svc');
    expect(endpoint).toBe('https://host/api/gateway/ctrl1/svc/');
    expect(endpoint).toBe(`https://host${buildGatewayBasePath('ctrl1', 'svc')}`);
    expect(endpoint).not.toContain('//api');
  });

  it('T-GWE5: 默认 dev base（config 缺省 http://localhost:10001）', () => {
    expect(buildGatewayEndpoint('http://localhost:10001', 'ctrl1', 'my-service')).toBe(
      'http://localhost:10001/api/gateway/ctrl1/my-service/',
    );
  });

  it('T-GWE6: 与代理路由形态对齐（/api/gateway/{controllerId}/{name}/）', () => {
    const basePath = buildGatewayBasePath('ctrl1', 'my-service');
    expect(basePath).toMatch(/^\/api\/gateway\/[^/]+\/[^/]+\/$/);
    // 尾部路径（子资源）直接拼在 basePath 之后即命中 `/gateway/:controllerId/:name/{*path}`
    expect(`${basePath}hello`).toBe('/api/gateway/ctrl1/my-service/hello');
  });
});
