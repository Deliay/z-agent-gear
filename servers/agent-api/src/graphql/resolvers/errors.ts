import { GraphQLError } from 'graphql';

export const GLOBAL_WRITE_FORBIDDEN = '全局配置请在管理后台修改';

/**
 * 将 service 层抛出的错误转换为 GraphQLError，保证可读消息透传到客户端。
 * GraphQL Yoga 默认会把非 GraphQLError 的异常屏蔽为「Unexpected error.」，
 * 因此 service 层用于表达业务语义的 Error 必须在 resolver 层显式转换。
 *
 * @param err 原始错误
 * @param mappings 额外的「消息包含 → 对外文案」映射（如 E11000）
 */
export function rethrowAsGraphQLError(
  err: unknown,
  mappings: Array<[needle: string, message: string]> = [],
): never {
  if (err instanceof GraphQLError) {
    throw err;
  }

  const message = err instanceof Error ? err.message : String(err);

  if (message === GLOBAL_WRITE_FORBIDDEN) {
    throw new GraphQLError(GLOBAL_WRITE_FORBIDDEN);
  }

  for (const [needle, mapped] of mappings) {
    if (message.includes(needle)) {
      throw new GraphQLError(mapped);
    }
  }

  throw new GraphQLError(message);
}
