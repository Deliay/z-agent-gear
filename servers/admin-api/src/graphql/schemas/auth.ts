export const authTypeDefs = `#graphql
  type AdminUser {
    id: ID!
    username: String!
    mustChangePassword: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type AdminAuthPayload {
    token: String!
    admin: AdminUser!
  }

  extend type Query {
    adminMe: AdminUser
  }

  extend type Mutation {
    # 登录；不存在注册 mutation
    adminLogin(username: String!, password: String!): AdminAuthPayload!
    # 修改密码（需已登录）；成功后 mustChangePassword=false 并签发新 token
    changeAdminPassword(oldPassword: String!, newPassword: String!): AdminAuthPayload!
  }
`;
