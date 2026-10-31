import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createApolloClient } from './lib/apollo'
import { resolveApiBase } from './lib/api-base'
import { logger } from './lib/logger'
import './index.css'
import App from './App.tsx'

function renderApp(apiBase: string) {
  const client = createApolloClient(apiBase)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ApolloProvider client={client}>
        <App />
      </ApolloProvider>
    </StrictMode>,
  )
}

async function bootstrap() {
  const root = document.getElementById('root')
  // 探测最坏耗时 2s，先给出加载占位，避免启动期白屏。
  if (root) root.textContent = '加载中…'

  let apiBase: string
  try {
    apiBase = await resolveApiBase()
  } catch (error) {
    // 解析异常（如隐私模式/沙箱下 sessionStorage 不可用）时降级，避免白屏。
    logger.error({ err: error }, '[bootstrap] resolveApiBase failed, falling back to env')
    apiBase = import.meta.env.VITE_API_URL || ''
  }

  renderApp(apiBase)
}

bootstrap()
