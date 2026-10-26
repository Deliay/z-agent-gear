import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads.js';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script.js';
import { DOCKER_SCRIPT_V3, DOCKER_APT_PARAM } from './003-docker-apt-source.js';
import { DOTNET_SCRIPT } from './001-preset-workloads.js';
import { GITHUB_INIT_SCRIPT } from './007-preset-github.js';
import { ASPIRE_SCRIPT_V2 } from './004-aspire-cli-source.js';
import { ASPIRE_SCRIPT_V1 } from './001-preset-workloads.js';
import { ASPIRE_CLI_PARAM } from './004-aspire-cli-source.js';
import { HARNESS_OPENCODE_INIT_SCRIPT, HARNESS_OPENCODE_INIT_SCRIPT_V1 } from './006-preset-harness-opencode.js';
import { HARNESS_KIMI_CODE_INIT_SCRIPT } from './009-preset-harness-kimi-code.js';
import { HARNESS_DEEPSEEK_INIT_SCRIPT, HARNESS_DEEPSEEK_INIT_SCRIPT_V1 } from './010-preset-harness-deepseek.js';

export const name = '012-worker-user-scripts';
const SUDO = 'SUDO=sudo; command -v sudo >/dev/null || SUDO=\n';
const WORKSPACE = '/home/worker/workspace';

function withSudo(script: string): string {
  const inserted = script.replace('set -euo pipefail\n', `set -euo pipefail\n\n${SUDO}`);
  return inserted
    .replace(/^(\s*)apt-get /gm, '$1${SUDO} apt-get ')
    .replace(/ > (\/etc\/[^\s]+)/g, ' | ${SUDO} tee $1 >/dev/null');
}

function sudoRootWrites(script: string): string {
  let s = script;
  for (const cmd of [
    'install -m 0755 -d /etc',
    'chmod a+r /etc',
    'mkdir -p /usr/local',
    'rm -rf /var/lib/apt/lists',
    'ln -sf /usr/libexec',
    'curl ',
  ]) {
    const pattern = new RegExp(`^(\\s*)${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm');
    s = s.replace(pattern, `$1\${SUDO} ${cmd}`);
  }
  s = s
    .replace('cat > "$SHIM_PATH" <<\'SHIM\'', '${SUDO} tee "$SHIM_PATH" >/dev/null <<\'SHIM\'')
    .replace('chmod +x "$SHIM_PATH"', '${SUDO} chmod +x "$SHIM_PATH"');
  return s;
}

export const DOTNET_SCRIPT_V2 = withSudo(DOTNET_SCRIPT);
export const GITHUB_SCRIPT_V2 = sudoRootWrites(withSudo(GITHUB_INIT_SCRIPT));
export const ASPIRE_SCRIPT_V3 = sudoRootWrites(withSudo(ASPIRE_SCRIPT_V2))
  .replace(/^(\s*)ln -sfn "\$HOME\/\.aspire/gm, '$1${SUDO} ln -sfn "$HOME/.aspire')
  .replace('ln -sfn "$ASPIRE_BIN" /usr/local/bin/aspire', '${SUDO} ln -sfn "$ASPIRE_BIN" /usr/local/bin/aspire')
  .replace(/^(\s*)chmod \+x \/etc\/profile\.d\/aspire\.sh/gm, '$1${SUDO} chmod +x /etc/profile.d/aspire.sh');
export const HARNESS_OPENCODE_SCRIPT_V2 = HARNESS_OPENCODE_INIT_SCRIPT
  .replace('${ZAG_DEFAULT_WORKSPACE:-/root/workspace}', `\${ZAG_DEFAULT_WORKSPACE:-${WORKSPACE}}`);
export const HARNESS_KIMI_CODE_SCRIPT_V2 = HARNESS_KIMI_CODE_INIT_SCRIPT
  .replace('${ZAG_DEFAULT_WORKSPACE:-/root/workspace}', `\${ZAG_DEFAULT_WORKSPACE:-${WORKSPACE}}`);
export const HARNESS_DEEPSEEK_SCRIPT_V2 = HARNESS_DEEPSEEK_INIT_SCRIPT
  .replace('${ZAG_DEFAULT_WORKSPACE:-/root/workspace}', `\${ZAG_DEFAULT_WORKSPACE:-${WORKSPACE}}`);

export const DOCKER_SCRIPT_V4 = sudoRootWrites(withSudo(DOCKER_SCRIPT_V3))
  .replace(
    '  nohup dockerd >/var/log/dockerd.log 2>&1 &',
    "  \${SUDO} sh -c 'nohup dockerd -G worker >/var/log/dockerd.log 2>&1 &'",
  );

export const GITHUB_TARGET_PATH_LEGACY = '/root/workspaces/{repo}';
export const GITHUB_TARGET_PATH_V2 = '/home/worker/workspace';

interface MutableWorkload {
  initScript?: string | null;
  paramSchema?: Array<Record<string, unknown>> | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

interface Target {
  presetKey: string;
  name: string;
  oldScripts: string[];
  newScript: string;
  create: Record<string, unknown>;
}

async function findWorkload(presetKey: string, name: string) {
  const byKey = await CloudWorkload.findOne({ presetKey });
  if (byKey) return { doc: byKey, viaName: false };
  const byName = await CloudWorkload.findOne({ name });
  return byName ? { doc: byName, viaName: true } : null;
}

async function refresh(t: Target): Promise<void> {
  const found = await findWorkload(t.presetKey, t.name);
  if (!found) {
    await CloudWorkload.create({ name: t.name, presetKey: t.presetKey, ...t.create, initScript: t.newScript });
    console.log(`[Migration 012] ${t.presetKey} created (v2)`);
    return;
  }
  const doc = found.doc as unknown as MutableWorkload;
  if (found.viaName && !doc.initScript) {
    console.warn(`[Migration 012] ${t.name} exists without presetKey, skipping`);
    return;
  }
  if (doc.initScript === t.newScript) return;
  if (!t.oldScripts.includes(doc.initScript ?? '')) {
    console.warn(`[Migration 012] ${t.presetKey} script modified by admin, skipping`);
    return;
  }
  doc.initScript = t.newScript;
  await doc.save();
  console.log(`[Migration 012] ${t.presetKey} script refreshed`);
}

async function refreshGithubTargetPath(): Promise<void> {
  const doc = (await findWorkload('github', 'Github'))?.doc as unknown as MutableWorkload | undefined;
  if (!doc) return;
  const schema = Array.isArray(doc.paramSchema) ? doc.paramSchema : [];
  const field = schema.find((item) => item?.key === 'targetPath');
  if (!field) return;
  const current = field.defaultValue;
  if (current === GITHUB_TARGET_PATH_V2) return;
  if (current === GITHUB_TARGET_PATH_LEGACY) {
    field.defaultValue = '/home/worker/workspaces/{repo}';
  } else if (current === '/root/workspace') {
    field.defaultValue = GITHUB_TARGET_PATH_V2;
  } else {
    console.warn('[Migration 012] github targetPath customized by admin, skipping');
    return;
  }
  doc.markModified?.('paramSchema');
  await doc.save();
  console.log('[Migration 012] github targetPath default refreshed');
}

export async function run(): Promise<void> {
  await refresh({
    presetKey: 'docker',
    name: 'Docker',
    oldScripts: [DOCKER_SCRIPT_V1, DOCKER_SCRIPT_V2, DOCKER_SCRIPT_V3],
    newScript: DOCKER_SCRIPT_V4,
    create: { postScript: null, paramSchema: [DOCKER_APT_PARAM], dependsOnWorkloadIds: [], isPreset: true },
  });
  await refresh({
    presetKey: 'dotnet',
    name: '.NET',
    oldScripts: [DOTNET_SCRIPT],
    newScript: DOTNET_SCRIPT_V2,
    create: { postScript: null, paramSchema: [], dependsOnWorkloadIds: [], isPreset: true, workloadKind: 'standard' },
  });
  await refresh({
    presetKey: 'github',
    name: 'Github',
    oldScripts: [GITHUB_INIT_SCRIPT],
    newScript: GITHUB_SCRIPT_V2,
    create: { postScript: null, paramSchema: [], dependsOnWorkloadIds: [], isPreset: true, workloadKind: 'standard', harnessType: null },
  });
  await refresh({
    presetKey: 'aspire',
    name: 'Aspire',
    oldScripts: [ASPIRE_SCRIPT_V1, ASPIRE_SCRIPT_V2],
    newScript: ASPIRE_SCRIPT_V3,
    create: { postScript: null, paramSchema: [ASPIRE_CLI_PARAM], dependsOnWorkloadIds: [], isPreset: true, workloadKind: 'standard' },
  });
  await refresh({ presetKey: 'harness-opencode', name: 'OpenCode（Harness）', oldScripts: [HARNESS_OPENCODE_INIT_SCRIPT, HARNESS_OPENCODE_INIT_SCRIPT_V1], newScript: HARNESS_OPENCODE_SCRIPT_V2, create: harnessCreate('opencode') });
  await refresh({ presetKey: 'harness-kimi-code', name: 'Kimi Code（Harness）', oldScripts: [HARNESS_KIMI_CODE_INIT_SCRIPT], newScript: HARNESS_KIMI_CODE_SCRIPT_V2, create: harnessCreate('kimi_code') });
  await refresh({ presetKey: 'harness-deepseek-harness', name: 'DeepSeek Harness（Harness）', oldScripts: [HARNESS_DEEPSEEK_INIT_SCRIPT, HARNESS_DEEPSEEK_INIT_SCRIPT_V1], newScript: HARNESS_DEEPSEEK_SCRIPT_V2, create: harnessCreate('deepseek_harness') });
  await refreshGithubTargetPath();
}

function harnessCreate(harnessType: string): Record<string, unknown> {
  return { postScript: null, paramSchema: [], dependsOnWorkloadIds: [], isPreset: true, workloadKind: 'harness', harnessType };
}
