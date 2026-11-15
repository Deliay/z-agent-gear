// 严格对齐 contracts/custom-tool.graphql（见 schemas/custom-tool.test.ts 逐字段比对）
// 安全红线：CustomTool 无任何 Valut 明文出参（仅引用名）
export const customToolTypeDefs = `#graphql
  enum CustomToolType {
    prompt
    http
  }

  enum FragmentType {
    Plain
    Valut
    Parameter
  }

  enum FragmentFormat {
    Generic
    Json
    Uri
  }

  enum CustomToolBodyType {
    text
    json
    form
  }

  enum CustomToolFormFieldType {
    text
    file
  }

  type Fragment {
    type: FragmentType!
    value: String!
    format: FragmentFormat!
  }

  type CustomToolArg {
    key: String!
    name: String!
    description: String
  }

  type CustomToolFormField {
    key: String!
    type: CustomToolFormFieldType!
    value: [Fragment!]!
  }

  type CustomToolKeyValue {
    key: String!
    value: [Fragment!]!
  }

  type CustomToolHttpConfig {
    method: String!
    endpoint: [Fragment!]!
    insecure: Boolean!
    bodyType: CustomToolBodyType
    body: [Fragment!]
    form: [CustomToolFormField!]
    headers: [CustomToolKeyValue!]!
    queries: [CustomToolKeyValue!]!
  }

  type CustomTool {
    id: ID!
    name: String!
    description: String
    type: CustomToolType!
    args: [CustomToolArg!]!
    prompt: [Fragment!]
    http: CustomToolHttpConfig
    workspaceId: ID!
    createdBy: String!
    createdAt: String!
    updatedAt: String!
  }

  input FragmentInput {
    type: FragmentType!
    value: String!
    format: FragmentFormat!
  }

  input CustomToolArgInput {
    key: String!
    name: String!
    description: String
  }

  input CustomToolFormFieldInput {
    key: String!
    type: CustomToolFormFieldType!
    value: [FragmentInput!]!
  }

  input CustomToolKeyValueInput {
    key: String!
    value: [FragmentInput!]!
  }

  input CustomToolHttpConfigInput {
    method: String!
    endpoint: [FragmentInput!]!
    insecure: Boolean
    bodyType: CustomToolBodyType
    body: [FragmentInput!]
    form: [CustomToolFormFieldInput!]
    headers: [CustomToolKeyValueInput!]
    queries: [CustomToolKeyValueInput!]
  }

  input CreateCustomToolInput {
    name: String!
    description: String
    type: CustomToolType!
    args: [CustomToolArgInput!]!
    prompt: [FragmentInput!]
    http: CustomToolHttpConfigInput
  }

  input UpdateCustomToolInput {
    name: String
    description: String
    type: CustomToolType
    args: [CustomToolArgInput!]
    prompt: [FragmentInput!]
    http: CustomToolHttpConfigInput
  }

  extend type Query {
    customTools: [CustomTool!]!
    customTool(id: ID!): CustomTool
  }

  extend type Mutation {
    createCustomTool(input: CreateCustomToolInput!): CustomTool!
    updateCustomTool(id: ID!, input: UpdateCustomToolInput!): CustomTool!
    deleteCustomTool(id: ID!): Boolean!
  }
`;
