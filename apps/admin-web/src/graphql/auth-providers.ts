import { gql } from '@apollo/client'

export const OIDC_PROVIDERS_QUERY = gql`
  query OidcProviders {
    oidcProviders {
      id
      type
      displayName
      issuer
      clientId
      scopes
      enabled
      enableFrontLogin
      enableAdminLogin
      hasSecret
      callbackUrl
      createdAt
      updatedAt
    }
  }
`

export const GITHUB_OAUTH_CONFIG_QUERY = gql`
  query GithubOauthConfig {
    githubOauthConfig {
      id
      type
      clientId
      enabled
      enableFrontLogin
      enableAdminLogin
      hasSecret
      callbackUrl
      createdAt
      updatedAt
    }
  }
`

export const CREATE_OIDC_PROVIDER = gql`
  mutation CreateOidcProvider($input: OidcProviderInput!) {
    createOidcProvider(input: $input) {
      id
    }
  }
`

export const UPDATE_OIDC_PROVIDER = gql`
  mutation UpdateOidcProvider($id: ID!, $input: OidcProviderInput!) {
    updateOidcProvider(id: $id, input: $input) {
      id
    }
  }
`

export const DELETE_OIDC_PROVIDER = gql`
  mutation DeleteOidcProvider($id: ID!) {
    deleteOidcProvider(id: $id)
  }
`

export const UPSERT_GITHUB_CONFIG = gql`
  mutation UpsertGithubOauthConfig($input: GithubOauthInput!) {
    upsertGithubOauthConfig(input: $input) {
      id
    }
  }
`

export const ADMIN_EXTERNAL_LOGINS = gql`
  query AdminExternalLogins {
    adminExternalLogins {
      id
      providerId
      providerDisplayName
      externalUsername
      createdAt
    }
  }
`

export const ADMIN_AUTH_PROVIDERS = gql`
  query AdminAuthProviders {
    adminAuthProviders {
      id
      type
      displayName
    }
  }
`

export const CREATE_ADMIN_BIND_TICKET = gql`
  mutation CreateAdminBindTicket($providerId: ID!) {
    createAdminBindTicket(providerId: $providerId)
  }
`

export const UNBIND_ADMIN_EXTERNAL_LOGIN = gql`
  mutation UnbindAdminExternalLogin($id: ID!) {
    unbindAdminExternalLogin(id: $id)
  }
`
