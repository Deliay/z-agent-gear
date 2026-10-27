import mongoose from 'mongoose';

/** 租户类型（一期仅 personal；team 预留）。 */
export const TENANT_TYPES = ['personal', 'team'] as const;
export type TenantType = (typeof TENANT_TYPES)[number];

/**
 * 租户（集合 `tenants`）。
 *
 * 三层帐号模型第三层：personal 租户 `_id` 复用 owner user 的 `_id`（tenantId==userId），
 * 余额/计费 ownerId 因此零映射。无成员列表——成员关系由 `users.tenantId` 承载
 * （tenant→users 一对多）；一期无删除/加成员入口。
 */
const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    type: { type: String, enum: TENANT_TYPES, required: true, default: 'personal' },
  },
  { timestamps: true },
);

export const Tenant = mongoose.model('Tenant', tenantSchema);
export type ITenant = mongoose.InferSchemaType<typeof tenantSchema>;
