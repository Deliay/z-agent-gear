type PackageManager = 'npm' | 'pnpm' | 'bun' | 'pm2';
type ServerRegion = 'global' | 'cn';

const ENDPOINTS: Record<ServerRegion, string> = {
  global: 'https://zag-ctrl-api.fffdan.com',
  cn: 'https://ctrl.zag.cn.fffdan.com',
};

const PACKAGE_RUNNERS: Record<Exclude<PackageManager, 'pm2'>, string> = {
  npm: 'npx',
  pnpm: 'pnpm dlx',
  bun: 'bunx',
};

export interface Pm2Result {
  installHint: string;
  pm2ConfigJson: string;
}

export function buildControllerCommand(opts: {
  pm: PackageManager;
  region: ServerRegion;
  key: string;
}): string | Pm2Result {
  const { pm, region, key } = opts;
  const endpoint = ENDPOINTS[region];

  if (pm === 'pm2') {
    const installHint = 'npm install -g agent-gear';
    const config = {
      apps: [
        {
          name: 'agent-gear',
          script: 'agent-gear',
          env: {
            ZAG_CONTROLLER_KEY: key,
            ZAG_SERVER_ENDPOINT: endpoint,
          },
        },
      ],
    };
    return {
      installHint,
      pm2ConfigJson: JSON.stringify(config, null, 2),
    };
  }

  const runner = PACKAGE_RUNNERS[pm];
  return `${runner} agent-gear --key ${key} --server ${endpoint}`;
}