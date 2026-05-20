export interface ControllerKeyData {
  id: string
  name: string
  type: string
  keyPrefix: string
  status: string
  rawKey: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ControllerData {
  id: string
  name: string
  hostname: string
  type: string
  status: string
  keyId: string
  version: string
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ControllerWorkspaceData {
  id: string
  userId: string
  controllerId: string
  name: string
  path: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface FolderEntryData {
  name: string
  path: string
  isDirectory: boolean
}

export interface ProviderData {
  id: string
  name: string
  type: string
  endpoint: string
  credentialType: string
  credentialValue: string
  isEnabled: boolean
  models: Array<{
    id: string
    name: string
    isEnabled: boolean
    sortOrder: number
  }>
  createdAt: string
  updatedAt: string
}

export interface ModelData {
  id: string
  providerId: string
  provider?: {
    id: string
    name: string
    type: string
    isEnabled: boolean
  }
  name: string
  isCustom: boolean
  isEnabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface SessionData {
  id: string
  userId: string
  controllerId: string
  controllerName: string
  acpServerType: string
  status: string
  title: string | null
  externalSessionId: string | null
  cwd: string | null
  createdAt: string
  updatedAt: string
  endedAt: string | null
}

export interface AcpMessageData {
  id: string
  sessionId: string
  direction: string
  type: string
  content: string
  metadata: string | null
  createdAt: string
}

export interface AcpCapabilityData {
  type: string
  available: boolean
  version: string | null
}

export interface GetControllerKeysQuery {
  controllerKeys: ControllerKeyData[]
}

export interface GetControllersQuery {
  controllers: ControllerData[]
}

export interface GetControllerWorkspacesQuery {
  controllerWorkspaces: ControllerWorkspaceData[]
}

export interface GetProvidersQuery {
  providers: ProviderData[]
}

export interface GetModelsQuery {
  models: ModelData[]
}

export interface GetSessionsQuery {
  sessions: SessionData[]
}

export interface GetSessionQuery {
  session: SessionData | null
}

export interface GetSessionMessagesQuery {
  sessionMessages: AcpMessageData[]
}

export interface GetAcpCapabilitiesQuery {
  acpCapabilities: AcpCapabilityData[]
}

export interface CreateControllerKeyMutation {
  createControllerKey: {
    key: ControllerKeyData
    rawKey: string
  }
}

export interface CreateWorkspaceMutation {
  createWorkspace: ControllerWorkspaceData
}

export interface ToggleWorkspaceMutation {
  toggleWorkspace: ControllerWorkspaceData
}

export interface CreateSessionMutation {
  createSession: {
    session: SessionData
  }
}

export interface SendSessionMessageMutation {
  sendSessionMessage: AcpMessageData
}
