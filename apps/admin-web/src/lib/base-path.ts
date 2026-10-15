// 应用部署基路径：取自 Vite BASE_URL，去除末尾斜杠。
// 与 BrowserRouter 的 basename 保持一致，用于非根路径部署时拼接跳转地址
// （避免硬编码 `/login`、`/change-password` 在子路径部署下失效）。

export function getBasePath(): string {
  const base = import.meta.env.BASE_URL || '/'
  return base.replace(/\/$/, '')
}
