import crypto from 'node:crypto';

/** Mongoose lean/created 文档的 `_id` 读取（Mongoose 9 的 InferSchemaType 不含 `_id`）。 */
export function documentId(doc: unknown): string {
  const value = (doc as { _id?: unknown } | null | undefined)?._id;
  return value === undefined || value === null ? '' : String(value);
}

/** 由业务键派生确定性 ObjectId：重放/并发写入同一账单，唯一索引兜底。 */
export function deterministicObjectId(seed: string): string {
  return crypto.createHash('md5').update(seed).digest('hex').slice(0, 24);
}
