// 页面级副作用封装，便于在测试中 mock。
// 切换到新的服务器地址后，ApolloClient 需要重新创建，因此整页刷新。

export function reloadApp(): void {
  if (typeof window === 'undefined') return;
  if (typeof window.location?.reload === 'function') {
    window.location.reload();
  }
}
