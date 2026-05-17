import { GraphQLError } from 'graphql';
import { User } from '../../models/user.js';
import { hashPassword, verifyPassword, signToken } from '../../services/auth.js';

export interface AuthContext {
  currentUser: {
    id: string;
    username: string;
  } | null;
}

export const authResolvers = {
  Query: {
    me: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        return null;
      }
      return context.currentUser;
    },
  },
  Mutation: {
    signup: async (_parent: unknown, args: { username: string; password: string }) => {
      const existing = await User.findOne({ username: args.username });
      if (existing) {
        throw new GraphQLError('Username already taken');
      }

      if (args.username.length < 2 || args.username.length > 20) {
        throw new GraphQLError('Username must be between 2 and 20 characters');
      }

      if (args.password.length < 6) {
        throw new GraphQLError('Password must be at least 6 characters');
      }

      const passwordHash = await hashPassword(args.password);
      const user = await User.create({ username: args.username, passwordHash });
      const token = signToken(user._id.toString());

      return {
        token,
        user: {
          id: user._id.toString(),
          username: user.username,
          createdAt: user.createdAt.toISOString(),
        },
      };
    },
    login: async (_parent: unknown, args: { username: string; password: string }) => {
      const user = await User.findOne({ username: args.username });
      if (!user) {
        throw new GraphQLError('Invalid username or password');
      }

      const valid = await verifyPassword(args.password, user.passwordHash);
      if (!valid) {
        throw new GraphQLError('Invalid username or password');
      }

      const token = signToken(user._id.toString());

      return {
        token,
        user: {
          id: user._id.toString(),
          username: user.username,
          createdAt: user.createdAt.toISOString(),
        },
      };
    },
  },
};
