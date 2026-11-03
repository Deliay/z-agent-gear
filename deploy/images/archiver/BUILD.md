# archiver 镜像构建与验收（云存储，需求 #405）

独立于 worker 镜像的一次性任务镜像：`tar` + `pbzip2`（`bzip2` 回退）+ `coreutils`，
以 root 运行（读取 uid 1000 的 worker 主目录、写入归档 PVC）。

## 构建（内网环境执行）

```bash
docker build -t core.harbor.internal.fffdan.com/zero-tools/archiver:latest deploy/images/archiver
```

apt 源默认走内网 Nexus 代理；如不可达可用 `--build-arg` 覆盖：

```bash
docker build \
  --build-arg UBUNTU_MIRROR=http://<nexus>/repository/ubuntu-proxy/ \
  -t archiver:dev deploy/images/archiver
```

## 本地静态检查（无需 docker）

```bash
bash -n deploy/images/archiver/entrypoint.sh
```

## 手工验收

1. 工具链存在：

   ```bash
   docker run --rm --entrypoint sh archiver:dev -c 'tar --version | head -1; pbzip2 -V; du --version | head -1'
   ```

2. **archive**（原子替换 + 用量标记行）：准备两个目录 `src/`（放一个 >1MiB 文件）与
   `archive/`（放旧归档 `old.tar.gz2`），然后：

   ```bash
   docker run --rm \
     -v "$PWD/src:/source:ro" -v "$PWD/archive:/archive" \
     -e MODE=archive -e SOURCE_DIR=/source -e ARCHIVE_ROOT=/archive \
     -e WORKSPACE_ID=ws1 -e STORAGE_ID=st1 -e ARCHIVE_FILE=my-pc-20261102-153012.tar.gz2 \
     archiver:dev
   ```

   预期：输出 `ZAG_ARCHIVE_RESULT={"usageBytes":N}`；`archive/ws1/st1/` 下只有新归档
   （旧 `old.tar.gz2` 已删除，无 `.tmp` 残留）。

3. **restore**：

   ```bash
   docker run --rm \
     -v "$PWD/archive:/archive:ro" -v "$PWD/target:/target" \
     -e MODE=restore \
     -e RESTORE_FILE=/archive/ws1/st1/my-pc-20261102-153012.tar.gz2 \
     archiver:dev
   ```

   预期：输出 `ZAG_RESTORE_DONE`，`target/` 内容与 `src/` 一致。

4. **usage**：`-e MODE=usage -e SOURCE_DIR=/source` 输出同一标记行。

5. **cleanup**：`-e MODE=cleanup -e WORKSPACE_ID=ws1 -e STORAGE_ID=st1` 后
   `archive/ws1/st1/` 目录被删除。

## 运行期口径（cloud-controller）

- 归档 Job：`deploy/k8s/cloud-controller.yaml` 的 `ARCHIVER_IMAGE` 指向本镜像；
  source PVC 只读挂 `/source`、归档 PVC 挂 `/archive`；
- 恢复：云电脑 Job 的 `storage-restore` initContainer 使用同一镜像（`tar -xjf`）；
- 用量：du Job 只读挂载 source PVC 并固定 `nodeName`（RWO 同节点）。
