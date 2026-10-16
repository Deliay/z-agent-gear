// 手写 GraphQL 类型（无 codegen），与 contracts/admin-*.graphql 人工对齐。

export type ConfigScope = 'user' | 'global';

// ---------- 认证（contracts/admin-auth.graphql） ----------

export interface AdminUserData {
  id: string;
  username: string;
  mustChangePassword: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminAuthPayloadData {
  token: string;
  admin: AdminUserData;
}

export interface GetAdminMeQuery {
  adminMe: AdminUserData | null;
}

export interface AdminLoginMutation {
  adminLogin: AdminAuthPayloadData;
}

export interface ChangeAdminPasswordMutation {
  changeAdminPassword: AdminAuthPayloadData;
}

// ---------- 全局供应商/模型（contracts/admin-llm.graphql） ----------

export interface AdminProviderModelData {
  id: string;
  providerId: string;
  name: string;
  isCustom: boolean;
  isEnabled: boolean;
  sortOrder: number;
  scope: ConfigScope;
}

export interface AdminProviderData {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  credentialType: string;
  credentialValue: string;
  isEnabled: boolean;
  scope: ConfigScope;
  models: AdminProviderModelData[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminModelProviderData {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  scope: ConfigScope;
}

export interface AdminModelData {
  id: string;
  providerId: string;
  provider?: AdminModelProviderData;
  name: string;
  isCustom: boolean;
  isEnabled: boolean;
  sortOrder: number;
  scope: ConfigScope;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInputData {
  name: string;
  type: string;
  endpoint: string;
  credentialType: string;
  credentialValue: string;
}

export interface GetAdminProvidersQuery {
  adminProviders: AdminProviderData[];
}

export interface GetAdminModelsQuery {
  adminModels: AdminModelData[];
}

export interface GetAdminModelsByProviderQuery {
  adminModelsByProvider: AdminModelData[];
}

export interface BatchPayloadData {
  successCount: number;
}

export interface BatchEnableGlobalProvidersMutation {
  batchEnableGlobalProviders: BatchPayloadData;
}

export interface BatchDisableGlobalProvidersMutation {
  batchDisableGlobalProviders: BatchPayloadData;
}

export interface BatchDeleteGlobalProvidersMutation {
  batchDeleteGlobalProviders: BatchPayloadData;
}

// ---------- 基础镜像（contracts/admin-base-image.graphql） ----------

export interface BaseImageData {
  id: string;
  name: string;
  description: string | null;
  dockerfile: string;
  createdAt: string;
  updatedAt: string;
}

export interface BaseImageInputData {
  name: string;
  description: string | null;
  dockerfile: string;
}

export interface GetBaseImagesQuery {
  baseImages: BaseImageData[];
}

export interface GetBaseImageQuery {
  baseImage: BaseImageData | null;
}

// ---------- 云端容器（contracts/admin-cloud-container.graphql） ----------

export type CloudContainerStatus =
  | 'CREATING'
  | 'CONNECTING'
  | 'ONLINE'
  | 'DESTROYING'
  | 'EXITED'
  | 'FAILED';

export type CloudContainerPurpose = 'IDLE' | 'ADMIN_TASK' | 'WORKFLOW' | 'SESSION';

export interface CloudContainerData {
  id: string;
  name: string;
  status: CloudContainerStatus;
  purpose: CloudContainerPurpose;
  refId: string | null;
  createdAt: string;
  connectedAt: string | null;
  exitedAt: string | null;
  exitReason: string | null;
}

export interface CloudContainerControlPlaneData {
  online: boolean;
  message: string | null;
}

export interface GetAdminCloudContainersQuery {
  adminCloudContainers: CloudContainerData[];
  adminCloudContainerControlPlane: CloudContainerControlPlaneData;
}

export interface AdminStartCloudContainerMutation {
  adminStartCloudContainer: CloudContainerData;
}

export interface AdminDestroyCloudContainerMutation {
  adminDestroyCloudContainer: boolean;
}
