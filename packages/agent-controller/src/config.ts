import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse, stringify } from 'smol-toml';

const CONFIG_DIR = join(homedir(), '.zag');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');

export interface ConfigData {
  key?: { value: string };
  server?: { endpoint: string };
  controller?: { name: string };
}

export function readConfig(): ConfigData {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = readFileSync(CONFIG_FILE, 'utf-8');
  return parse(content) as ConfigData;
}

export function writeConfig(data: ConfigData): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, stringify(data), 'utf-8');
}

export function clearConfigKey(): void {
  const config = readConfig();
  delete config.key;
  writeConfig(config);
}

export function getKeyFromConfig(): string | undefined {
  const config = readConfig();
  return config.key?.value;
}

export function getEndpointFromConfig(): string | undefined {
  const config = readConfig();
  return config.server?.endpoint;
}

export function getControllerNameFromConfig(): string | undefined {
  const config = readConfig();
  return config.controller?.name;
}

export function saveKeyToConfig(key: string): void {
  const config = readConfig();
  config.key = { value: key };
  writeConfig(config);
}

export function saveEndpointToConfig(endpoint: string): void {
  const config = readConfig();
  config.server = { endpoint };
  writeConfig(config);
}

export function resolveKey(cliKey?: string): string | undefined {
  if (cliKey) return cliKey;
  const envKey = process.env.ZAG_CONTROLLER_KEY;
  if (envKey) return envKey;
  return getKeyFromConfig();
}

export function resolveEndpoint(cliEndpoint?: string): string | undefined {
  if (cliEndpoint) return cliEndpoint;
  const envEndpoint = process.env.ZAG_SERVER_ENDPOINT;
  if (envEndpoint) return envEndpoint;
  return getEndpointFromConfig();
}
