import { logger } from '../observability/logger.js';
import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads.js';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script.js';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source.js';
import { DOCKER_SCRIPT_V4 } from './012-worker-user-scripts.js';

const log = logger.child({ component: 'migration/020-docker-shim-value-options' });

/**
 * 020-docker-shim-value-options：把「Docker」预制工作负载的镜像代理 shim 从「首个非选项参数即镜像」
 * 的启发式刷新为「识别带值选项后取首个位置参数」。
 *
 * 背景：shim 生成自本仓库的 Docker 预制工作负载脚本（003 v3 → 012 v4），并非测试环境镜像自带。
 * 旧逻辑不识别 `--name/-e/-p/-v/--platform` 等需要接值的选项，会把选项值当成镜像改写：
 *
 *   docker create --name mongodb-xxx mongo:7
 *   → docker create --name core.harbor.../mongodb-xxx mongo:7
 *   → invalid container name（容器创建失败）
 *
 * 修复口径（shim 内 `pull` 与 `run|create` 分别解析）：
 * - `--opt=value` 整段透传；
 * - 长选项按 `VALUE_LONG_OPTS` 跳过其值；未知长选项按无值布尔处理（宁可漏归一化，也不污染镜像后的命令参数）；
 * - 短选项按字符簇解析，`-e FOO=bar` 跳过下一参数，`-eFOO=bar` 整段透传，`-it` 等布尔簇不受影响；
 * - `pull` 的 `-a/-q` 是布尔，仅 `--platform` 需要跳过值；
 * - 只对跳过选项后的首个位置参数调用 `normalize_image`。
 *
 * 历史版本常量保持不变（迁移按字节匹配存量脚本）；v5 由 v4 做定点替换生成。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '020-docker-shim-value-options';

const OLD_ARG_LOOP = `cmd="\${1:-}"
case "\$cmd" in
  pull|run|create)
    args=("\$cmd"); shift; normalized=0
    for a in "\$@"; do
      if [ "\$normalized" -eq 0 ] && [ "\${a#-}" = "\$a" ]; then
        args+=("\$(normalize_image "\$a")"); normalized=1
      else
        args+=("\$a")
      fi
    done
    exec /usr/bin/docker "\${args[@]}" ;;
  *) exec /usr/bin/docker "\$@" ;;
esac`;

const NEW_ARG_LOOP = `# 需要接值的长选项（run/create）。未知长选项按布尔处理，避免吞掉镜像/命令参数。
VALUE_LONG_OPTS=" --add-host --annotation --attach --blkio-weight --blkio-weight-device \\
--cap-add --cap-drop --cgroup-parent --cgroupns --cidfile --cpu-count --cpu-percent \\
--cpu-period --cpu-quota --cpu-rt-period --cpu-rt-runtime --cpu-shares --cpus \\
--cpuset-cpus --cpuset-mems --detach-keys --device --device-cgroup-rule \\
--device-read-bps --device-read-iops --device-write-bps --device-write-iops \\
--dns --dns-opt --dns-option --dns-search --domainname --entrypoint --env --env-file \\
--expose --gpus --group-add --health-cmd --health-interval --health-retries \\
--health-start-interval --health-start-period --health-timeout --hostname --ip --ip6 \\
--ipc --isolation --kernel-memory --label --label-file --link --link-local-ip \\
--log-driver --log-opt --mac-address --memory --memory-reservation --memory-swap \\
--memory-swappiness --mount --name --net --net-alias --network --network-alias \\
--oom-score-adj --pid --pids-limit --platform --publish --pull --restart --runtime \\
--security-opt --shm-size --stop-signal --stop-timeout --storage-opt --sysctl --tmpfs \\
--ulimit --user --userns --uts --volume --volume-driver --volumes-from --workdir "

# 需要接值的短选项字符（run/create）：-a -c -e -h -l -m -p -u -v -w
IS_VALUE_SHORT() {
  case "\$1" in
    a|c|e|h|l|m|p|u|v|w) return 0 ;;
    *) return 1 ;;
  esac
}

cmd="\${1:-}"
case "\$cmd" in
  pull)
    args=("\$cmd"); shift; normalized=0
    while [ "\$#" -gt 0 ]; do
      a="\$1"; shift
      case "\$a" in
        --)
          args+=("\$a")
          while [ "\$#" -gt 0 ]; do
            if [ "\$normalized" -eq 0 ]; then
              args+=("\$(normalize_image "\$1")"); normalized=1
            else
              args+=("\$1")
            fi
            shift
          done ;;
        --*=*) args+=("\$a") ;;
        --platform)
          args+=("\$a")
          if [ "\$#" -gt 0 ]; then args+=("\$1"); shift; fi ;;
        --*) args+=("\$a") ;;
        -?*) args+=("\$a") ;;
        *)
          if [ "\$normalized" -eq 0 ]; then
            args+=("\$(normalize_image "\$a")"); normalized=1
          else
            args+=("\$a")
          fi ;;
      esac
    done
    exec /usr/bin/docker "\${args[@]}" ;;
  run|create)
    args=("\$cmd"); shift; normalized=0
    while [ "\$#" -gt 0 ]; do
      a="\$1"; shift
      case "\$a" in
        --)
          args+=("\$a")
          while [ "\$#" -gt 0 ]; do
            if [ "\$normalized" -eq 0 ]; then
              args+=("\$(normalize_image "\$1")"); normalized=1
            else
              args+=("\$1")
            fi
            shift
          done ;;
        --*=*) args+=("\$a") ;;
        --*)
          name="\${a%%=*}"
          args+=("\$a")
          case " \$VALUE_LONG_OPTS " in
            *" \$name "*)
              if [ "\$#" -gt 0 ]; then args+=("\$1"); shift; fi ;;
          esac ;;
        -?*)
          rest="\${a#-}"; takes_value=0
          while [ -n "\$rest" ]; do
            ch="\${rest:0:1}"
            if IS_VALUE_SHORT "\$ch"; then
              if [ "\${#rest}" -eq 1 ]; then takes_value=1; fi
              break
            fi
            rest="\${rest:1}"
          done
          args+=("\$a")
          if [ "\$takes_value" -eq 1 ] && [ "\$#" -gt 0 ]; then args+=("\$1"); shift; fi ;;
        *)
          if [ "\$normalized" -eq 0 ]; then
            args+=("\$(normalize_image "\$a")"); normalized=1
          else
            args+=("\$a")
          fi ;;
      esac
    done
    exec /usr/bin/docker "\${args[@]}" ;;
  *) exec /usr/bin/docker "\$@" ;;
esac`;

function withValueOptionParsing(script: string): string {
  if (!script.includes(OLD_ARG_LOOP)) {
    throw new Error('020 migration: docker shim argument loop not found in preset script');
  }
  return script.replace(OLD_ARG_LOOP, NEW_ARG_LOOP);
}

/** Docker 预制工作负载脚本 v5：v4 基础上修复镜像代理 shim 的带值选项解析。 */
export const DOCKER_SCRIPT_V5 = withValueOptionParsing(DOCKER_SCRIPT_V4);

interface MutableWorkload {
  initScript?: string | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

const DOCKER_PRESET_KEY = 'docker';
const DOCKER_PRESET_NAME = 'Docker';

async function findDockerWorkload() {
  const byKey = await CloudWorkload.findOne({ presetKey: DOCKER_PRESET_KEY });
  if (byKey) return { doc: byKey, viaName: false };
  const byName = await CloudWorkload.findOne({ name: DOCKER_PRESET_NAME });
  return byName ? { doc: byName, viaName: true } : null;
}

export async function run(): Promise<void> {
  const found = await findDockerWorkload();
  // 管理员已删除的预置项不恢复（迁移只增不改/删除即尊重）
  if (!found) return;

  const doc = found.doc as unknown as MutableWorkload;
  if (found.viaName && !doc.initScript) {
    log.warn({ name: DOCKER_PRESET_NAME }, 'workload exists without presetKey, skipping');
    return;
  }
  if (doc.initScript === DOCKER_SCRIPT_V5) return;

  const knownScripts = [
    DOCKER_SCRIPT_V1,
    DOCKER_SCRIPT_V2,
    DOCKER_SCRIPT_V3,
    DOCKER_SCRIPT_V4,
  ];
  if (!knownScripts.includes(doc.initScript ?? '')) {
    log.warn({ presetKey: DOCKER_PRESET_KEY }, 'script modified by admin, skipping');
    return;
  }

  doc.initScript = DOCKER_SCRIPT_V5;
  doc.markModified?.('initScript');
  await doc.save();
  log.info({ presetKey: DOCKER_PRESET_KEY }, 'docker shim refreshed to value-option aware v5');
}
