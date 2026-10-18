/** Mongoose lean/created 文档的 `_id` 读取（Mongoose 9 的 InferSchemaType 不含 `_id`）。 */
export function documentId(doc: unknown): string {
  const value = (doc as { _id?: unknown } | null | undefined)?._id;
  return value === undefined || value === null ? '' : String(value);
}

export function hasDocumentId(doc: unknown): boolean {
  return documentId(doc) !== '';
}
