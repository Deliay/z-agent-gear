import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createApolloClient } from './lib/apollo'
import { resolveAdminApiBase } from './lib/api-base'
import { renderBootstrapFallback } from './lib/bootstrap'
import { logger } from './lib/logger'
import { initTheme } from './lib/theme'
import './index.css'
import App from './App.tsx'

// 渲染前同步应用已存主题，避免首屏亮 → 暗闪烁。
initTheme()

async function bootstrap() {
  const root = document.getElementById('root')
  try {
    const apiBase = await resolveAdminApiBase()
    const client = createApolloClient(apiBase)

    createRoot(root!).render(
      <StrictMode>
        <ApolloProvider client={client}>
          <App />
        </ApolloProvider>
      </StrictMode>,
    )
  } catch (error) {
    logger.error({ err: error }, 'admin-web bootstrap failed')
    renderBootstrapFallback(root)
  }
}

bootstrap()
