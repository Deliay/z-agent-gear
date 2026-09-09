import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createApolloClient } from './lib/apollo'
import { resolveApiBase } from './lib/api-base'
import './index.css'
import App from './App.tsx'

async function bootstrap() {
  const apiBase = await resolveApiBase()
  const client = createApolloClient(apiBase)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ApolloProvider client={client}>
        <App />
      </ApolloProvider>
    </StrictMode>,
  )
}

bootstrap()
