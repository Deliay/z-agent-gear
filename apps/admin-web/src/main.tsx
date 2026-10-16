import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createApolloClient } from './lib/apollo'
import { resolveAdminApiBase } from './lib/api-base'
import { renderBootstrapFallback } from './lib/bootstrap'
import './index.css'
import App from './App.tsx'

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
    console.error('admin-web bootstrap failed', error)
    renderBootstrapFallback(root)
  }
}

bootstrap()
