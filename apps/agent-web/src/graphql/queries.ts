import { gql } from '@apollo/client'

export const GET_PROVIDERS = gql`
  query GetProviders {
    providers {
      id
      name
      type
      endpoint
      credentialType
      credentialValue
      isEnabled
      models {
        id
        providerId
        name
        isCustom
        isEnabled
        sortOrder
      }
      createdAt
      updatedAt
    }
  }
`

export const GET_MODELS = gql`
  query GetModels {
    models {
      id
      providerId
      provider {
        id
        name
        type
        isEnabled
      }
      name
      isCustom
      isEnabled
      sortOrder
      createdAt
      updatedAt
    }
  }
`

export const GET_MODELS_BY_PROVIDER = gql`
  query GetModelsByProvider($providerId: ID!) {
    modelsByProvider(providerId: $providerId) {
      id
      providerId
      name
      isCustom
      isEnabled
      sortOrder
    }
  }
`
