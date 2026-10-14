import { GraphQLError } from 'graphql';
import { AdminUser } from '../../models/admin-user.js';
import { login, changePassword, signToken } from '../../services/auth.js';

export interface AdminAuthContext {
  currentAdmin: {
    id: string;
    username: string;
    mustChangePassword: boolean;
  } | null;
}

interface AdminRecord {
  _id: { toString(): string };
  username: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function mapAdmin(admin: AdminRecord) {
  return {
    id: admin._id.toString(),
    username: admin.username,
    mustChangePassword: admin.mustChangePassword,
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString(),
  };
}

export const authResolvers = {
  Query: {
    adminMe: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      if (!context.currentAdmin) {
        return null;
      }
      const admin = await AdminUser.findById(context.currentAdmin.id).lean() as AdminRecord | null;
      if (!admin) return null;
      return mapAdmin(admin);
    },
  },
  Mutation: {
    adminLogin: async (_parent: unknown, args: { username: string; password: string }) => {
      try {
        const admin = await login(args.username, args.password);
        const token = signToken(admin._id.toString());
        return { token, admin: mapAdmin(admin as unknown as AdminRecord) };
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    changeAdminPassword: async (
      _parent: unknown,
      args: { oldPassword: string; newPassword: string },
      context: AdminAuthContext,
    ) => {
      if (!context.currentAdmin) {
        throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
      }
      try {
        const admin = await changePassword(context.currentAdmin.id, args.oldPassword, args.newPassword);
        const token = signToken(admin._id.toString());
        return { token, admin: mapAdmin(admin as unknown as AdminRecord) };
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
};
