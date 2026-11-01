import { test, expect } from '@playwright/test'
import { gqlRequest, loginViaUI } from './helpers'
import { SIDEBAR, sectionToggle, setupPhase4Env } from './phase4-helpers'

/**
 * UI 优化四期 · 侧边栏（E2E-UI4S1~S6）
 *
 * 覆盖：四折叠分区默认态与持久化、跨环境聚合、空态收敛、拖拽调宽、
 * 主机树层级缩进与设置按钮、移动端不回归。
 */
test.describe('侧边栏 UI 四期', () => {
  test('E2E-UI4S1 四分区默认展开态与刷新保持', async ({ page }) => {
    const env = await setupPhase4Env(page, 's1')
    await loginViaUI(page, env.username)

    await expect(page.locator(sectionToggle('workflows'))).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(sectionToggle('sessions'))).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(sectionToggle('hosts'))).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(sectionToggle('gateways'))).toHaveAttribute('aria-expanded', 'false')

    // 点击标题行切换，刷新后保持
    await page.locator(sectionToggle('hosts')).click()
    await page.locator(sectionToggle('sessions')).click()
    await expect(page.locator(sectionToggle('hosts'))).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(sectionToggle('sessions'))).toHaveAttribute('aria-expanded', 'false')

    await page.reload()
    await expect(page.locator(sectionToggle('hosts'))).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(sectionToggle('sessions'))).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(sectionToggle('workflows'))).toHaveAttribute('aria-expanded', 'true')

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4S2 两主机的会话/工作流聚合到同一列表且点击直达', async ({ page }) => {
    const env = await setupPhase4Env(page, 's2', {
      controllerCount: 2,
      withSessions: true,
      withInstances: true,
    })
    await loginViaUI(page, env.username)

    const sessionList = page.locator('[data-testid="sidebar-session-list"]')
    const workflowList = page.locator('[data-testid="sidebar-workflow-list"]')
    const sessionIds = await env.controllers.reduce<Promise<string[]>>(async (previous, controller) => {
      const ids = await previous
      const res = await gqlRequest(page, `query Sessions { sessions { id controllerId } }`, {}, env.token)
      const body = await res.json()
      const session = (body.data.sessions as Array<{ id: string; controllerId: string }>).find(
        (item) => item.controllerId === controller.controllerId,
      )
      expect(session).toBeTruthy()
      return [...ids, session!.id]
    }, Promise.resolve([]))

    for (const sessionId of sessionIds) {
      await expect(sessionList.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible()
    }
    for (const instance of env.instances) {
      await expect(workflowList.getByText(instance.name, { exact: true })).toBeVisible()
    }

    // 点击聚合条目直达对应会话
    await sessionList.locator(`a[href="/sessions/${sessionIds[1]}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionIds[1]}$`))

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4S3 空态收敛：无会话/工作流/网关时不出现占位文字', async ({ page }) => {
    const env = await setupPhase4Env(page, 's3')
    await loginViaUI(page, env.username)

    await page.locator(sectionToggle('gateways')).click()
    await page.locator(sectionToggle('hosts')).click()

    for (const placeholder of ['无会话', '无工作流实例', '无网关暴露', '无工作区']) {
      await expect(page.locator(SIDEBAR)).not.toContainText(placeholder)
    }
    await expect(page.locator('[data-testid="sidebar-session-list"]')).toBeVisible()
    await expect(page.locator('[data-testid="sidebar-session-list"] > li')).toHaveCount(0)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4S4 拖拽调宽 clamp 240–448、刷新保持、双击恢复默认', async ({ page }) => {
    const env = await setupPhase4Env(page, 's4')
    await loginViaUI(page, env.username)

    const sidebar = page.locator(SIDEBAR)
    const initialBox = await sidebar.boundingBox()
    expect(initialBox).toBeTruthy()
    expect(Math.round(initialBox!.width)).toBeGreaterThanOrEqual(240)
    expect(Math.round(initialBox!.width)).toBeLessThanOrEqual(448)

    const resizer = page.locator('[data-testid="sidebar-resizer"]')
    const box = await resizer.boundingBox()
    expect(box).toBeTruthy()

    // 向右拖到上限
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 100)
    await page.mouse.down()
    await page.mouse.move(box!.x + 600, box!.y + 100, { steps: 5 })
    await page.mouse.up()
    const maxBox = await sidebar.boundingBox()
    expect(Math.round(maxBox!.width)).toBe(448)

    // 刷新后保持
    await page.reload()
    await expect(page.locator(SIDEBAR)).toBeVisible()
    const persistedBox = await page.locator(SIDEBAR).boundingBox()
    expect(Math.round(persistedBox!.width)).toBe(448)

    // 双击恢复默认 20rem = 320px
    await page.locator('[data-testid="sidebar-resizer"]').dblclick()
    const resetBox = await page.locator(SIDEBAR).boundingBox()
    expect(Math.round(resetBox!.width)).toBe(320)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4S5 主机树层级缩进一致且设置按钮保留', async ({ page }) => {
    const env = await setupPhase4Env(page, 's5')
    await loginViaUI(page, env.username)
    await page.locator(sectionToggle('hosts')).click()

    const workspaceSection = page.locator('[data-tree-level="1"]').first()
    await expect(workspaceSection).toBeVisible()
    const paddingLeft = await workspaceSection.evaluate((element) => getComputedStyle(element).paddingLeft)
    expect(paddingLeft).toBe('8px')

    const settingsButton = page.locator(`${SIDEBAR} [title="控制器配置"]`).first()
    await expect(settingsButton).toBeVisible()
    await settingsButton.click()
    await expect(page).toHaveURL(/\/settings\?controllerId=/)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4S6 移动端不回归：无 Resizer、无横向溢出', async ({ page }) => {
    const env = await setupPhase4Env(page, 's6')
    await page.setViewportSize({ width: 390, height: 844 })
    await loginViaUI(page, env.username)

    await expect(page.locator(SIDEBAR)).toBeVisible()
    await expect(page.locator('[data-testid="sidebar-resizer"]')).toHaveCount(0)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)

    env.controllers.forEach((controller) => controller.disconnect())
  })
})
