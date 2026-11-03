# scripts

仓库级工具脚本（无第三方依赖，纯 Node ESM）。

| 脚本 | 说明 |
|------|------|
| `sync-observability.mjs` | 单源观测模块（`packages/observability/src`）→ 5 包 `src/observability/` vendored 副本同步；`--check` 只校验（CI / `tests/api` 一致性测试复用） |

## 使用

```bash
node scripts/sync-observability.mjs          # 写入副本（缺失目标目录自动创建）
node scripts/sync-observability.mjs --check  # 校验一致性，不一致退出码 1
```

**禁止直接改 vendored 副本**：改 `packages/observability/src` → 跑本脚本 → 提交全部副本（见 `packages/observability/README.md`）。
