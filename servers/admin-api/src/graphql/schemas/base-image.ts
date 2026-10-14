export const baseImageTypeDefs = `#graphql
  type BaseImage {
    id: ID!
    name: String!
    description: String
    dockerfile: String!
    createdAt: String!
    updatedAt: String!
  }

  input BaseImageInput {
    name: String!
    description: String
    dockerfile: String!
  }

  extend type Query {
    baseImages: [BaseImage!]!
    baseImage(id: ID!): BaseImage
  }

  extend type Mutation {
    createBaseImage(input: BaseImageInput!): BaseImage!
    updateBaseImage(id: ID!, input: BaseImageInput!): BaseImage!
    deleteBaseImage(id: ID!): Boolean!
  }
`;
