import { gql } from '@apollo/client'

/**
 * 自定义工具（工作区）GraphQL 域文件（契约 `contracts/custom-tool.graphql`，计划 D10）。
 * 与 preview.ts / workflow.ts 域文件同形态：查询/变更与手写类型集中在本文件。
 */

export type CustomToolType = 'prompt' | 'http'
export type FragmentType = 'Plain' | 'Valut' | 'Parameter'
export type FragmentFormat = 'Generic' | 'Json' | 'Uri'
export type CustomToolBodyType = 'text' | 'json' | 'form'
export type CustomToolFormFieldType = 'text' | 'file'

export interface FragmentData {
  type: FragmentType
  value: string
  format: FragmentFormat
}

export interface CustomToolArgData {
  key: string
  name: string
  description: string | null
}

export interface CustomToolFormFieldData {
  key: string
  type: CustomToolFormFieldType
  value: FragmentData[]
}

export interface CustomToolKeyValueData {
  key: string
  value: FragmentData[]
}

export interface CustomToolHttpConfigData {
  method: string
  endpoint: FragmentData[]
  insecure: boolean
  bodyType: CustomToolBodyType | null
  body: FragmentData[] | null
  form: CustomToolFormFieldData[] | null
  headers: CustomToolKeyValueData[]
  queries: CustomToolKeyValueData[]
}

export interface CustomToolData {
  id: string
  name: string
  description: string | null
  type: CustomToolType
  args: CustomToolArgData[]
  prompt: FragmentData[] | null
  http: CustomToolHttpConfigData | null
  workspaceId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface CustomToolArgInput {
  key: string
  name: string
  description?: string | null
}

export interface CustomToolFormFieldInput {
  key: string
  type: CustomToolFormFieldType
  value: FragmentData[]
}

export interface CustomToolKeyValueInput {
  key: string
  value: FragmentData[]
}

export interface CustomToolHttpConfigInput {
  method: string
  endpoint: FragmentData[]
  insecure?: boolean
  bodyType?: CustomToolBodyType | null
  body?: FragmentData[]
  form?: CustomToolFormFieldInput[]
  headers?: CustomToolKeyValueInput[]
  queries?: CustomToolKeyValueInput[]
}

export interface CreateCustomToolInput {
  name: string
  description?: string | null
  type: CustomToolType
  args: CustomToolArgInput[]
  prompt?: FragmentData[]
  http?: CustomToolHttpConfigInput | null
}

export interface UpdateCustomToolInput {
  name?: string
  description?: string | null
  type?: CustomToolType
  args?: CustomToolArgInput[]
  prompt?: FragmentData[]
  http?: CustomToolHttpConfigInput | null
}

const FRAGMENT_FIELDS = gql`
  fragment FragmentFields on Fragment {
    type
    value
    format
  }
`

const KEY_VALUE_FIELDS = gql`
  fragment CustomToolKeyValueFields on CustomToolKeyValue {
    key
    value {
      ...FragmentFields
    }
  }
  ${FRAGMENT_FIELDS}
`

const HTTP_FIELDS = gql`
  fragment CustomToolHttpFields on CustomToolHttpConfig {
    method
    endpoint {
      ...FragmentFields
    }
    insecure
    bodyType
    body {
      ...FragmentFields
    }
    form {
      key
      type
      value {
        ...FragmentFields
      }
    }
    headers {
      ...CustomToolKeyValueFields
    }
    queries {
      ...CustomToolKeyValueFields
    }
  }
  ${FRAGMENT_FIELDS}
  ${KEY_VALUE_FIELDS}
`

const CUSTOM_TOOL_FIELDS = gql`
  fragment CustomToolFields on CustomTool {
    id
    name
    description
    type
    args {
      key
      name
      description
    }
    prompt {
      ...FragmentFields
    }
    http {
      ...CustomToolHttpFields
    }
    workspaceId
    createdBy
    createdAt
    updatedAt
  }
  ${FRAGMENT_FIELDS}
  ${HTTP_FIELDS}
`

export const GET_CUSTOM_TOOLS = gql`
  query GetCustomTools {
    customTools {
      ...CustomToolFields
    }
  }
  ${CUSTOM_TOOL_FIELDS}
`

export const GET_CUSTOM_TOOL = gql`
  query GetCustomTool($id: ID!) {
    customTool(id: $id) {
      ...CustomToolFields
    }
  }
  ${CUSTOM_TOOL_FIELDS}
`

export const CREATE_CUSTOM_TOOL = gql`
  mutation CreateCustomTool($input: CreateCustomToolInput!) {
    createCustomTool(input: $input) {
      ...CustomToolFields
    }
  }
  ${CUSTOM_TOOL_FIELDS}
`

export const UPDATE_CUSTOM_TOOL = gql`
  mutation UpdateCustomTool($id: ID!, $input: UpdateCustomToolInput!) {
    updateCustomTool(id: $id, input: $input) {
      ...CustomToolFields
    }
  }
  ${CUSTOM_TOOL_FIELDS}
`

export const DELETE_CUSTOM_TOOL = gql`
  mutation DeleteCustomTool($id: ID!) {
    deleteCustomTool(id: $id)
  }
`

export interface GetCustomToolsQuery {
  customTools: CustomToolData[]
}

export interface GetCustomToolQuery {
  customTool: CustomToolData | null
}

export interface CreateCustomToolMutation {
  createCustomTool: CustomToolData
}

export interface UpdateCustomToolMutation {
  updateCustomTool: CustomToolData
}

export interface DeleteCustomToolMutation {
  deleteCustomTool: boolean
}
