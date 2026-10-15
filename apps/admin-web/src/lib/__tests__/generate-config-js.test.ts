/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 仅在 POSIX shell 可用时运行（脚本面向 nginx:alpine 的 /bin/sh）。
// vitest 的 cwd 即 apps/admin-web，脚本随包一起移植。
const scriptPath = join(process.cwd(), 'docker-entrypoint.d', '40-generate-config-js.sh');

function runScript(adminApiUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-config-js-'));
  const configFile = join(dir, 'config.js');
  const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_FILE: configFile };
  if (adminApiUrl === undefined) {
    delete env.ADMIN_API_URL;
  } else {
    env.ADMIN_API_URL = adminApiUrl;
  }

  try {
    const result = spawnSync('sh', [scriptPath], { env, encoding: 'utf8' });
    const content = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
    return { status: result.status, stderr: result.stderr, content };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('40-generate-config-js.sh', () => {
  it('writes the apiUrl for a valid ADMIN_API_URL', () => {
    const { status, content } = runScript('https://admin-api.example.com');
    expect(status).toBe(0);
    expect(content).toBe('window.__ADMIN_CONFIG__ = { apiUrl: "https://admin-api.example.com" };\n');
  });

  it('writes an empty config when ADMIN_API_URL is unset', () => {
    const { status, content } = runScript(undefined);
    expect(status).toBe(0);
    expect(content).toBe('window.__ADMIN_CONFIG__ = {};\n');
  });

  it('rejects a URL with an invalid scheme (fail startup)', () => {
    const { status, content } = runScript('ftp://evil.example.com');
    expect(status).not.toBe(0);
    expect(content).not.toContain('evil.example.com');
  });

  it('rejects a value attempting JS string-literal breakout', () => {
    const { status, content } = runScript('https://evil.example.com";alert(1);//');
    expect(status).not.toBe(0);
    expect(content).not.toContain('alert(1)');
    expect(content).toBe('');
  });

  it('rejects a value containing a backslash or whitespace', () => {
    expect(runScript('https://evil.example.com\\natexit').status).not.toBe(0);
    expect(runScript('https://evil.example.com extra').status).not.toBe(0);
  });

  it('rejects a value containing a script-closing / HTML-tag sequence', () => {
    const closing = runScript('https://evil.example.com</script><script>alert(1)</script>');
    expect(closing.status).not.toBe(0);
    expect(closing.content).toBe('');

    const comment = runScript('https://evil.example.com<!--x-->');
    expect(comment.status).not.toBe(0);

    const tag = runScript('https://evil.example.com"><img src=x>');
    expect(tag.status).not.toBe(0);
  });
});
