import mongoose from 'mongoose';
import { CloudHostSpec } from '../models/cloud-host-spec.js';
import { Tenant } from '../models/tenant.js';
import {
  assertSpecResources,
  isUnlimitedSpec,
  SPEC_MAX_CPU,
  SPEC_MAX_EPHEMERAL_STORAGE_GI,
  SPEC_MAX_MEMORY_GI,
} from './billing/spec-pricing.js';

export const SPEC_WHITELIST_MAX_TENANTS = 200;

export interface AdminCloudSpecInput {
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  whitelistEnabled: boolean;
  allowedTenantIds: string[];
}

export interface AdminCloudSpecDTO {
  id: string;
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  unlimited: boolean;
  whitelistEnabled: boolean;
  allowedTenantIds: string[];
  isPreset: boolean;
  presetKey: string | null;
  createdAt: string;
  updatedAt: string;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

/** 归一 + 校验规格输入（错误文案逐字对齐契约）。 */
async function normalizeInput(input: AdminCloudSpecInput): Promise<{
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  whitelistEnabled: boolean;
  allowedTenantIds: string[];
}> {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('name is required');
  if (name.length > 64) throw new Error('name is too long');

  const cpu = Number(input.cpu);
  const memoryGi = Number(input.memoryGi);
  const ephemeralStorageGi = Number(input.ephemeralStorageGi);
  if (
    !Number.isFinite(cpu) ||
    !Number.isFinite(memoryGi) ||
    !Number.isFinite(ephemeralStorageGi) ||
    !Number.isInteger(cpu) ||
    !Number.isInteger(memoryGi) ||
    !Number.isInteger(ephemeralStorageGi) ||
    cpu > SPEC_MAX_CPU ||
    memoryGi > SPEC_MAX_MEMORY_GI ||
    ephemeralStorageGi > SPEC_MAX_EPHEMERAL_STORAGE_GI
  ) {
    throw new Error('invalid spec resources');
  }
  try {
    assertSpecResources({ cpu, memoryGi, ephemeralStorageGi });
  } catch {
    throw new Error('invalid spec resources');
  }

  const whitelistEnabled = input.whitelistEnabled === true;
  if (!whitelistEnabled) {
    // D10：白名单关闭时服务端置空（口径唯一，避免「隐藏的白名单」）。
    return { name, cpu, memoryGi, ephemeralStorageGi, whitelistEnabled, allowedTenantIds: [] };
  }

  const rawIds = Array.isArray(input.allowedTenantIds) ? input.allowedTenantIds : [];
  const allowedTenantIds: string[] = [];
  for (const value of rawIds) {
    if (typeof value !== 'string') throw new Error('invalid tenant in whitelist');
    const id = value.trim();
    if (!id) continue;
    if (!mongoose.isValidObjectId(id)) throw new Error('invalid tenant in whitelist');
    if (!allowedTenantIds.includes(id)) allowedTenantIds.push(id);
  }
  if (allowedTenantIds.length > SPEC_WHITELIST_MAX_TENANTS) {
    throw new Error('invalid tenant in whitelist');
  }
  if (allowedTenantIds.length > 0) {
    const found = await Tenant.find({ _id: { $in: allowedTenantIds } })
      .select({ _id: 1 })
      .lean<Array<{ _id: unknown }>>();
    if (found.length !== allowedTenantIds.length) {
      throw new Error('invalid tenant in whitelist');
    }
  }
  return { name, cpu, memoryGi, ephemeralStorageGi, whitelistEnabled, allowedTenantIds };
}

function mapSpec(doc: Record<string, unknown>): AdminCloudSpecDTO {
  const cpu = Number(doc.cpu ?? 0);
  const memoryGi = Number(doc.memoryGi ?? 0);
  const ephemeralStorageGi = Number(doc.ephemeralStorageGi ?? 0);
  return {
    id: String(doc._id ?? doc.id ?? ''),
    name: String(doc.name ?? ''),
    cpu,
    memoryGi,
    ephemeralStorageGi,
    unlimited: isUnlimitedSpec({ cpu, memoryGi, ephemeralStorageGi }),
    whitelistEnabled: doc.whitelistEnabled === true,
    allowedTenantIds: Array.isArray(doc.allowedTenantIds)
      ? doc.allowedTenantIds.map((value) => String(value))
      : [],
    isPreset: doc.isPreset === true,
    presetKey: typeof doc.presetKey === 'string' && doc.presetKey ? doc.presetKey : null,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

export class CloudHostSpecService {
  async list(): Promise<AdminCloudSpecDTO[]> {
    const docs = await CloudHostSpec.find().sort({ createdAt: 1 }).lean();
    return docs.map((doc) => mapSpec(doc as unknown as Record<string, unknown>));
  }

  async get(id: string): Promise<AdminCloudSpecDTO | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await CloudHostSpec.findById(id).lean();
    return doc ? mapSpec(doc as unknown as Record<string, unknown>) : null;
  }

  async create(input: AdminCloudSpecInput): Promise<AdminCloudSpecDTO> {
    const values = await normalizeInput(input);
    await this.assertNameAvailable(values.name, null);
    try {
      const doc = await CloudHostSpec.create({ ...values, isPreset: false, presetKey: null });
      return mapSpec(doc.toObject() as unknown as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new Error('spec name already exists');
      throw err;
    }
  }

  async update(id: string, input: AdminCloudSpecInput): Promise<AdminCloudSpecDTO> {
    if (!mongoose.isValidObjectId(id)) throw new Error('spec not found');
    const values = await normalizeInput(input);
    await this.assertNameAvailable(values.name, id);
    try {
      const doc = await CloudHostSpec.findOneAndUpdate(
        { _id: id },
        { $set: values },
        { returnDocument: 'after' },
      ).lean();
      if (!doc) throw new Error('spec not found');
      return mapSpec(doc as unknown as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new Error('spec name already exists');
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await CloudHostSpec.deleteOne({ _id: id });
    return result.deletedCount === 1;
  }

  private async assertNameAvailable(name: string, excludeId: string | null): Promise<void> {
    const filter: Record<string, unknown> = { name };
    if (excludeId) filter._id = { $ne: excludeId };
    const existing = await CloudHostSpec.findOne(filter).select({ _id: 1 }).lean();
    if (existing) throw new Error('spec name already exists');
  }
}

export const cloudHostSpecService = new CloudHostSpecService();
