import { gql } from '@apollo/client'

export const ADMIN_ME = gql`
  query AdminMe {
    adminMe {
      id
      username
      mustChangePassword
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_PROVIDERS = gql`
  query AdminProviders {
    adminProviders {
      id
      name
      type
      endpoint
      credentialType
      credentialValue
      isEnabled
      scope
      models {
        id
        providerId
        name
        isCustom
        isEnabled
        sortOrder
        scope
      }
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_MODELS = gql`
  query AdminModels {
    adminModels {
      id
      providerId
      provider {
        id
        name
        type
        isEnabled
        scope
      }
      name
      isCustom
      isEnabled
      sortOrder
      scope
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_MODELS_BY_PROVIDER = gql`
  query AdminModelsByProvider($providerId: ID!) {
    adminModelsByProvider(providerId: $providerId) {
      id
      providerId
      name
      isCustom
      isEnabled
      sortOrder
      scope
    }
  }
`

export const BASE_IMAGES = gql`
  query BaseImages {
    baseImages {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const BASE_IMAGE = gql`
  query BaseImage($id: ID!) {
    baseImage(id: $id) {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_CLOUD_CONTAINERS = gql`
  query AdminCloudContainers {
    adminCloudContainers {
      id
      name
      status
      purpose
      refId
      createdAt
      connectedAt
      exitedAt
      exitReason
      workloads {
        id
        name
      }
      currentWorkloadName
    }
    adminCloudContainerControlPlane {
      online
      message
    }
  }
`

export const ADMIN_CLOUD_WORKLOADS = gql`
  query AdminCloudWorkloads {
    adminCloudWorkloads {
      id
      name
      initScript
      postScript
      paramSchema {
        key
        label
        type
        options
        defaultValue
      }
      dependsOnWorkloadIds
      isPreset
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_CLOUD_WORKLOAD_LOGS = gql`
  query AdminCloudContainerWorkloadLogs($containerId: ID!) {
    adminCloudContainerWorkloadLogs(containerId: $containerId) {
      id
      containerId
      workloadId
      workloadName
      phase
      status
      script
      params
      exitCode
      log
      startedAt
      finishedAt
    }
  }
`
