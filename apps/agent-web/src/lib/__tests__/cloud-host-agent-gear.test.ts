import { describe, expect, it } from 'vitest'
import type { CloudHostData } from '../../graphql/types'
import {
  AGENT_GEAR_UPGRADE_POLL_INTERVAL_MS,
  AGENT_GEAR_UPGRADE_TIMEOUT_MS,
  AGENT_GEAR_UPGRADE_TIMEOUT_MESSAGE,
  CLOUD_HOST_AGENT_GEAR_ERROR_MESSAGES,
  agentGearUpgradeErrorMessage,
  isAgentGearUpgradeAvailable,
} from '../cloud-host-agent-gear'

const CONTRACT_ERRORS = [
  'Not authenticated',
  'Cloud host not found',
  'cloud host is not running',
  'container is not online',
  'agent-gear upgrade is not supported by the current version',
  'agent-gear upgrade already in progress',
  'internal error',
]

function makeHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-1',
    name: '云电脑 A',
    status: 'RUNNING',
    harnessTypes: ['OPENCODE'],
    activeSessionCount: 0,
    deletedAt: null,
    agentGearVersion: {
      currentVersion: '2.19.0',
      latestVersion: '2.20.0',
      upgradeAvailable: true,
      autoUpdateIntervalMinutes: 10,
    },
    ...overrides,
  }
}

describe('cloud-host-agent-gear', () => {
  describe('T-UPG-W-L1 错误文案映射', () => {
    it('契约六条白名单 + internal error 均映射为中文提示', () => {
      for (const message of CONTRACT_ERRORS) {
        const mapped = CLOUD_HOST_AGENT_GEAR_ERROR_MESSAGES[message]
        expect(mapped).toBeTruthy()
        expect(mapped).not.toBe(message)
        expect(agentGearUpgradeErrorMessage(new Error(message))).toBe(mapped)
      }
    })

    it('未命中原样展示，非 Error 走兜底，前后空白归一', () => {
      expect(agentGearUpgradeErrorMessage(new Error('unexpected failure'))).toBe(
        'unexpected failure',
      )
      expect(agentGearUpgradeErrorMessage(new Error('  container is not online  '))).toBe(
        '云电脑未在线，请稍后重试或等待自动升级',
      )
      expect(agentGearUpgradeErrorMessage('boom')).toBe('工作组件升级失败，请稍后重试')
      expect(agentGearUpgradeErrorMessage(null, '自定义兜底')).toBe('自定义兜底')
    })

    it('轮询口径常量为 2s / 3 分钟且超时文案含自动升级指引', () => {
      expect(AGENT_GEAR_UPGRADE_POLL_INTERVAL_MS).toBe(2000)
      expect(AGENT_GEAR_UPGRADE_TIMEOUT_MS).toBe(180000)
      expect(AGENT_GEAR_UPGRADE_TIMEOUT_MESSAGE).toContain('自动升级')
    })
  })

  describe('T-UPG-W-L2 立即升级可见性门矩阵', () => {
    it('upgradeAvailable=true + RUNNING + 未删除 → 可用', () => {
      expect(isAgentGearUpgradeAvailable(makeHost())).toBe(true)
    })

    it('upgradeAvailable=false（版本一致）→ 不可用', () => {
      expect(
        isAgentGearUpgradeAvailable(
          makeHost({
            agentGearVersion: {
              currentVersion: '2.20.0',
              latestVersion: '2.20.0',
              upgradeAvailable: false,
              autoUpdateIntervalMinutes: 10,
            },
          }),
        ),
      ).toBe(false)
    })

    it('非 RUNNING（STARTING/STOPPED/FAILED）→ 不可用', () => {
      for (const status of ['STARTING', 'STOPPED', 'FAILED'] as const) {
        expect(isAgentGearUpgradeAvailable(makeHost({ status }))).toBe(false)
      }
    })

    it('已软删除（deletedAt 非空）→ 不可用', () => {
      expect(
        isAgentGearUpgradeAvailable(makeHost({ deletedAt: '2026-11-01T00:00:00.000Z' })),
      ).toBe(false)
    })

    it('版本字段缺失 / host 为空 → 不可用', () => {
      expect(isAgentGearUpgradeAvailable(makeHost({ agentGearVersion: null }))).toBe(false)
      expect(isAgentGearUpgradeAvailable(makeHost({ agentGearVersion: undefined }))).toBe(false)
      expect(isAgentGearUpgradeAvailable(null)).toBe(false)
      expect(isAgentGearUpgradeAvailable(undefined)).toBe(false)
    })
  })
})
