// 严格对齐 contracts/valut.graphql（安全红线：无 value 出参；见 schemas/valut.test.ts 逐字段比对）
export const valutTypeDefs = `#graphql
  type ValutNamespace {
    name: String!
    displayName: String!
    managed: Boolean!
  }

  type ValutRef {
    feature: String!
    refId: ID!
    refLabel: String
    createdAt: String!
  }

  type ValutEntry {
    id: ID!
    namespace: String!
    namespaceDisplayName: String!
    key: String!
    editable: Boolean!
    deletable: Boolean!
    refs: [ValutRef!]!
    createdBy: String!
    createdAt: String!
    updatedAt: String!
  }

  type ValutNamespaceGroup {
    namespace: ValutNamespace!
    entries: [ValutEntry!]!
  }

  input CreateValutEntryInput {
    key: String!
    value: String!
  }

  extend type Query {
    valutEntries: [ValutNamespaceGroup!]!
    valutManualOptions: [ValutEntry!]!
  }

  extend type Mutation {
    createValutEntry(input: CreateValutEntryInput!): ValutEntry!
    updateValutEntry(id: ID!, value: String!): ValutEntry!
    deleteValutEntry(id: ID!): Boolean!
  }
`;
