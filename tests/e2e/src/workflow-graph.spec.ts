import { test, expect, type Page } from '@playwright/test'
import { loginViaUI } from './helpers'
import {
  callWorkflowTool,
  completeHumanNode,
  getPhase4Instance,
  injectSessionUpdate,
  instantiatePhase4Workflow,
  nodeCard,
  seedInstance,
  seedPullRequestLink,
  setupPhase4Env,
  waitFor,
  type InstantiateNodeInput,
  type Phase4Controller,
  type Phase4Instance,
} from './phase4-helpers'

/**
 * UI 优化四期 · 工作流图表（E2E-UI4G1~G10）+ 工作流迭代（E2E-WFI1~WFI3）
 *
 * 覆盖：竖向布局与画布占满、主题跟随与卡片不透明、状态整体配色、加粗箭头连线、
 * 人类节点就地操作、节点详情抽屉、进行中静态指示、完成态 token、资源上图、徽标行，
 * 以及自动定位执行中节点与抽屉 PR 区块前置。
 */
test.describe('工作流图表 UI 四期', () => {
  test.skip(!process.env.MONGODB_URI, 'requires MONGODB_URI for workflow fixtures')

  async function openGraph(page: Page, instanceId: string) {
    await page.goto(`/workflows/${instanceId}`)
    await page.getByRole('button', { name: '图表' }).click()
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15000 })
  }

  async function setup(page: Page, tag: string) {
    const env = await setupPhase4Env(page, tag, { withInstances: true })
    const instance = env.instances[0]
    await loginViaUI(page, env.username)
    return { env, instance }
  }

  /** 推进到 AI 节点执行中（完成两个人类节点） */
  async function advanceToAiRunning(
    page: Page,
    token: string,
    instance: Phase4Instance,
    controller: Phase4Controller,
  ): Promise<{ sessionId: string; controller: Phase4Controller; start: { mcpEndpoint?: { token: string } } }> {
    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    const review = instance.nodes.find((node) => node.nodeKey === 'review')!
    await completeHumanNode(page, token, instance.id, input.id, '做一个计算器')
    await completeHumanNode(page, token, instance.id, review.id, '方案通过')
    const latest = await waitFor(async () => {
      const current = await getPhase4Instance(page, token, instance.id)
      const exec = current.nodes.find((node) => node.nodeKey === 'exec')
      return exec?.status === 'RUNNING' && exec.sessionId ? current : null
    }, 20000, 'AI 节点执行中')
    const exec = latest.nodes.find((node) => node.nodeKey === 'exec')!
    const start = await waitFor(
      () => controller.starts.find((item) => item.sessionId === exec.sessionId),
      15000,
      'acp:start',
    )
    return { sessionId: exec.sessionId!, controller, start }
  }

  test('E2E-UI4G1 竖向布局与画布占满', async ({ page }) => {
    const { env, instance } = await setup(page, 'g1')
    await openGraph(page, instance.id)

    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    const review = instance.nodes.find((node) => node.nodeKey === 'review')!
    const exec = instance.nodes.find((node) => node.nodeKey === 'exec')!

    const boxes = await Promise.all(
      [input, review, exec].map(async (node) => {
        const box = await page.locator(nodeCard(node.id)).boundingBox()
        expect(box).toBeTruthy()
        return box!
      }),
    )
    expect(boxes[0].y).toBeLessThan(boxes[1].y)
    expect(boxes[1].y).toBeLessThan(boxes[2].y)

    const canvas = await page.locator('.react-flow').boundingBox()
    expect(canvas).toBeTruthy()
    expect(canvas!.height).toBeGreaterThan(480)
    const viewport = page.viewportSize()!
    expect(canvas!.height).toBeGreaterThan(viewport.height * 0.6)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G2 卡片主题跟随且背景不透明', async ({ page }) => {
    const { env, instance } = await setup(page, 'g2')
    await page.evaluate(() => localStorage.setItem('theme', 'dark'))
    await page.reload()
    await openGraph(page, instance.id)

    const card = page.locator('[data-testid^="workflow-node-card-"]').first()
    const darkColor = await card.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(darkColor).not.toBe('rgb(255, 255, 255)')
    // 卡片底色不透明（禁止 rgba(..., alpha<1) 与 transparent）
    expect(darkColor).toMatch(/^rgb\(/)
    expect(darkColor).not.toMatch(/rgba\(.*,\s*0?\.\d+\)/)

    await page.evaluate(() => localStorage.setItem('theme', 'light'))
    await page.reload()
    await openGraph(page, instance.id)
    const lightColor = await page
      .locator('[data-testid^="workflow-node-card-"]')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(lightColor).not.toBe(darkColor)
    expect(lightColor).toMatch(/^rgb\(/)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G3 状态整体配色：REJECT≠FAILED，REWORK 带脉冲底纹', async ({ page }) => {
    const { env, instance } = await setup(page, 'g3')
    const [input, review, exec] = instance.nodes
    await seedInstance(instance.id, {
      'nodes.0.status': 'REJECT',
      'nodes.1.status': 'REWORK',
      'nodes.2.status': 'FAILED',
    })
    await openGraph(page, instance.id)

    const inputCard = page.locator(nodeCard(input.id))
    const reviewCard = page.locator(nodeCard(review.id))
    const execCard = page.locator(nodeCard(exec.id))

    const rejectSpine = await inputCard.locator('[data-testid="node-status-spine"]').evaluate((el) => getComputedStyle(el).backgroundColor)
    const failedSpine = await execCard.locator('[data-testid="node-status-spine"]').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(rejectSpine).not.toBe(failedSpine)

    await expect(reviewCard.locator('[data-testid^="node-status-badge-"]').first()).toHaveClass(/animate-pulse/)
    await expect(inputCard.locator('[data-testid^="node-status-badge-"]').first()).not.toHaveClass(/animate-pulse/)
    await expect(inputCard.locator('[data-testid^="node-status-badge-"]').first()).toHaveText('已打回')

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G4 连线可见、加粗且带箭头', async ({ page }) => {
    const { env, instance } = await setup(page, 'g4')
    await openGraph(page, instance.id)

    await expect(page.locator('.react-flow__edge')).toHaveCount(2)
    const edges = page.locator('.react-flow__edge-path')
    await expect(edges).toHaveCount(2)
    for (let index = 0; index < 2; index += 1) {
      const edge = edges.nth(index)
      // 自定义节点缺 Handle 时边不渲染，这里同时守卫「可见」
      await expect(edge).toBeVisible()
      const strokeWidth = await edge.evaluate((el) => Number(getComputedStyle(el).strokeWidth.replace('px', '')))
      expect(strokeWidth).toBeGreaterThanOrEqual(2)
      await expect(edge).toHaveAttribute('marker-end', /url\(#/)
    }

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G5 人类节点就地完成与打回', async ({ page }) => {
    const { env, instance } = await setup(page, 'g5')
    await openGraph(page, instance.id)

    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    const review = instance.nodes.find((node) => node.nodeKey === 'review')!

    const inputCard = page.locator(nodeCard(input.id))
    await inputCard.getByLabel('需求输入 完成输入').fill('图表内直接完成')
    await inputCard.getByRole('button', { name: '完成' }).click()
    await waitFor(async () => {
      const current = await getPhase4Instance(page, env.token, instance.id)
      return current.nodes.find((node) => node.id === input.id)?.status === 'DONE'
    }, 15000, 'input DONE')

    // review 变 READY 后可打回上游
    const reviewCard = page.locator(nodeCard(review.id))
    await expect(reviewCard.getByRole('button', { name: '打回' })).toBeVisible({ timeout: 15000 })
    await reviewCard.getByRole('button', { name: '打回' }).click()
    await page.getByLabel('打回理由').fill('请补充测试说明')
    await page.getByRole('button', { name: '确认打回' }).click()
    await waitFor(async () => {
      const current = await getPhase4Instance(page, env.token, instance.id)
      return current.nodes.find((node) => node.id === input.id)?.status === 'REWORK'
    }, 15000, 'input REWORK')

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G6 人类节点详情抽屉：打开与关闭回到原视图', async ({ page }) => {
    const { env, instance } = await setup(page, 'g6')
    await openGraph(page, instance.id)

    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    await page.locator(nodeCard(input.id)).getByRole('button', { name: '需求输入 详情' }).click()

    const drawer = page.getByTestId('node-detail-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('需求输入')
    await expect(drawer).toContainText('阶段')

    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/workflows/${instance.id}$`))

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G7 进行中 AI 节点动态行恒为「正在思考」', async ({ page }) => {
    const { env, instance } = await setup(page, 'g7')
    await openGraph(page, instance.id)
    const { sessionId, controller } = await advanceToAiRunning(page, env.token, instance, env.controllers[0])
    const exec = instance.nodes.find((node) => node.nodeKey === 'exec')!
    const liveRow = page.locator(`[data-testid="node-live-activity-${exec.id}"]`)
    await expect(liveRow).toContainText('正在思考', { timeout: 15000 })

    injectSessionUpdate(controller, sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `正在分析需求${'…'.repeat(3)}结尾片段` },
    })
    await expect(liveRow).toContainText('正在思考', { timeout: 10000 })
    await expect(liveRow).not.toContainText('结尾片段')

    injectSessionUpdate(controller, sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'execute',
      status: 'in_progress',
    })
    injectSessionUpdate(controller, sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      title: '执行 npm test',
    })
    await expect(liveRow).toContainText('正在思考', { timeout: 10000 })
    await expect(liveRow).not.toContainText('执行 npm test')

    injectSessionUpdate(controller, sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '正在总结实现结果' },
    })
    await expect(liveRow).toContainText('正在思考', { timeout: 10000 })
    await expect(liveRow).not.toContainText('正在总结实现结果')

    env.controllers.forEach((item) => item.disconnect())
  })

  test('E2E-UI4G8 完成态 token：注入 usage 后完成节点显示「已完成 · N tokens」', async ({ page }) => {
    const { env, instance } = await setup(page, 'g8')
    await openGraph(page, instance.id)
    const { sessionId, controller, start } = await advanceToAiRunning(page, env.token, instance, env.controllers[0])
    const exec = instance.nodes.find((node) => node.nodeKey === 'exec')!

    injectSessionUpdate(controller, sessionId, { sessionUpdate: 'usage_update', used: 4321 })
    await expect(
      page.locator(`[data-testid="node-live-activity-${exec.id}"]`),
    ).toBeVisible()

    const mcpToken = start.mcpEndpoint?.token
    expect(mcpToken).toBeTruthy()
    const result = await callWorkflowTool(controller, sessionId, mcpToken!, 'completeCurrentNode', {
      artifacts: [{ title: '实现产物', value: 'done' }],
    })
    expect(result.isError).toBe(false)

    const resultRow = page.locator(`[data-testid="node-result-${exec.id}"]`)
    await expect(resultRow).toContainText('已完成 · 4321 tokens', { timeout: 20000 })
    await expect(resultRow).not.toContainText('消耗')

    env.controllers.forEach((item) => item.disconnect())
  })

  test('E2E-UI4G9 资源上图：黑板/PR/追加提示词归属节点，垃圾桶不渲染，右栏隐藏', async ({ page }) => {
    const { env, instance } = await setup(page, 'g9')
    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    const review = instance.nodes.find((node) => node.nodeKey === 'review')!

    await seedInstance(instance.id, {
      [`blackboard.${input.id}-需求输入-产物-需求说明`]: '实现一个计算器',
      'blackboard.legacy-无法归属-key': '实例级黑板条目',
      'blackboardTrash.legacy-已删除-key': '不应展示',
      [`additionalPrompts.review`]: '请重点检查 inline comment',
      'nodes.1.status': 'RUNNING',
    })
    await seedPullRequestLink(instance.id, {
      nodeId: input.id,
      nodeKey: 'input',
      pullRequestId: 'acme/repo#9',
      prUrl: 'https://github.com/acme/repo/pull/9',
      checkRunUrl: 'https://github.com/acme/repo/runs/9',
      commitSha: 'abcdef1234567',
    })

    await openGraph(page, instance.id)

    const inputCard = page.locator(nodeCard(input.id))
    await expect(inputCard.getByTestId('resource-chip-blackboard')).toContainText('需求说明')
    await expect(inputCard.getByText('PR')).toBeVisible()
    await expect(inputCard.getByText('检查项')).toBeVisible()
    await expect(page.locator(nodeCard(review.id)).getByTestId('resource-chip-prompt')).toContainText('review')
    await expect(page.locator('[data-testid="instance-resource-row"]')).toContainText('legacy-无法归属-key')

    // 垃圾桶与右栏资源树不渲染
    await expect(page.locator('.react-flow')).not.toContainText('不应展示')
    await expect(page.getByTestId('blackboard-panel')).toHaveCount(0)
    await expect(page.getByText(/关联 Pull Request/)).toHaveCount(0)

    // 点击资源小卡片打开资源详情抽屉
    await inputCard.getByTestId('resource-chip-blackboard').click()
    await expect(page.getByTestId('node-detail-drawer')).toContainText('实现一个计算器')

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-UI4G10 徽标行：有 PR/检查项/返工记录时可见，无则隐藏', async ({ page }) => {
    const { env, instance } = await setup(page, 'g10')
    const input = instance.nodes.find((node) => node.nodeKey === 'input')!
    const exec = instance.nodes.find((node) => node.nodeKey === 'exec')!

    await seedInstance(instance.id, { 'nodes.0.reworkCount': 2 })
    await seedPullRequestLink(instance.id, {
      nodeId: input.id,
      nodeKey: 'input',
      pullRequestId: 'acme/repo#10',
      prUrl: 'https://github.com/acme/repo/pull/10',
      checkRunUrl: 'https://github.com/acme/repo/runs/10',
      commitSha: 'fedcba7654321',
    })

    await openGraph(page, instance.id)

    const inputCard = page.locator(nodeCard(input.id))
    await expect(inputCard.getByRole('link', { name: 'PR' })).toHaveAttribute(
      'href',
      'https://github.com/acme/repo/pull/10',
    )
    await expect(inputCard.getByRole('link', { name: '检查项' })).toBeVisible()
    await expect(inputCard.getByText('2', { exact: true })).toBeVisible()

    const execCard = page.locator(nodeCard(exec.id))
    await expect(execCard.getByRole('link', { name: 'PR' })).toHaveCount(0)
    await expect(execCard.getByRole('link', { name: '检查项' })).toHaveCount(0)

    env.controllers.forEach((controller) => controller.disconnect())
  })
})

/**
 * 工作流迭代 · 图表视图自动定位与抽屉排序（E2E-WFI1~WFI3）
 */
test.describe('工作流迭代 · 图表自动定位与抽屉排序', () => {
  test.skip(!process.env.MONGODB_URI, 'requires MONGODB_URI for workflow fixtures')

  async function openGraph(page: Page, instanceId: string) {
    await page.goto(`/workflows/${instanceId}`)
    await page.getByRole('button', { name: '图表' }).click()
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15000 })
  }

  /** 线性 7 节点图（人类节点，dependsOn 形成单链） */
  function sevenNodeChain(): InstantiateNodeInput[] {
    return Array.from({ length: 7 }, (_, index) => ({
      nodeKey: `n${index + 1}`,
      type: 'HUMAN',
      name: `节点${index + 1}`,
      stage: '阶段',
      dependsOn: index === 0 ? [] : [`n${index}`],
      requiresWorktree: false,
    }))
  }

  async function setupSeven(page: Page, tag: string) {
    const env = await setupPhase4Env(page, tag, { withInstances: false })
    const controller = env.controllers[0]
    const workspace = env.workspaces[0]
    const instance = await instantiatePhase4Workflow(
      page,
      env.token,
      controller.controllerId,
      workspace.id,
      `p4-${tag}-七节点-${Date.now().toString(36)}`,
      sevenNodeChain(),
    )
    await loginViaUI(page, env.username)
    return { env, instance }
  }

  /** 卡片中心与画布中心的相对偏移（比例） */
  async function centerOffset(page: Page, nodeId: string): Promise<{ dx: number; dy: number }> {
    const canvas = await page.locator('.react-flow').boundingBox()
    const card = await page.locator(nodeCard(nodeId)).boundingBox()
    expect(canvas).toBeTruthy()
    expect(card).toBeTruthy()
    return {
      dx: Math.abs(card!.x + card!.width / 2 - (canvas!.x + canvas!.width / 2)) / canvas!.width,
      dy: Math.abs(card!.y + card!.height / 2 - (canvas!.y + canvas!.height / 2)) / canvas!.height,
    }
  }

  test('E2E-WFI1 有执行中节点时居中，视野容纳前后各 2 卡片', async ({ page }) => {
    const { env, instance } = await setupSeven(page, 'wfi1')
    const [n1, n2, n3, n4, n5, n6, n7] = instance.nodes
    await seedInstance(instance.id, { 'nodes.3.status': 'RUNNING' })
    await openGraph(page, instance.id)

    // 执行中节点（n4）位于画布中心 ±15%
    await expect
      .poll(async () => {
        const offset = await centerOffset(page, n4.id)
        return offset.dx < 0.15 && offset.dy < 0.15
      }, { timeout: 15000, message: '执行中节点居中' })
      .toBe(true)

    const canvas = (await page.locator('.react-flow').boundingBox())!
    const withinCanvas = async (nodeId: string) => {
      const box = await page.locator(nodeCard(nodeId)).boundingBox()
      if (!box) return false
      // 与画布可见区域有非空交集
      return (
        box.y + box.height > canvas.y &&
        box.y < canvas.y + canvas.height &&
        box.x + box.width > canvas.x &&
        box.x < canvas.x + canvas.width
      )
    }

    // 前后各 2 个卡片可见
    expect(await withinCanvas(n2.id)).toBe(true)
    expect(await withinCanvas(n3.id)).toBe(true)
    expect(await withinCanvas(n5.id)).toBe(true)
    expect(await withinCanvas(n6.id)).toBe(true)
    // 首尾节点被裁出视口
    expect(await withinCanvas(n1.id)).toBe(false)
    expect(await withinCanvas(n7.id)).toBe(false)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-WFI2 执行中节点切换后视图自动重新定位', async ({ page }) => {
    const { env, instance } = await setupSeven(page, 'wfi2')
    const [, , n3, n4] = instance.nodes
    await seedInstance(instance.id, { 'nodes.3.status': 'RUNNING' })
    await openGraph(page, instance.id)

    await expect
      .poll(async () => (await centerOffset(page, n4.id)).dy < 0.15, { timeout: 15000 })
      .toBe(true)

    // 切换执行中节点：n4 → n3（5s 轮询后视图跟随）
    await seedInstance(instance.id, {
      'nodes.3.status': 'DONE',
      'nodes.2.status': 'RUNNING',
    })
    await expect
      .poll(async () => (await centerOffset(page, n3.id)).dy < 0.15, { timeout: 20000 })
      .toBe(true)

    env.controllers.forEach((controller) => controller.disconnect())
  })

  test('E2E-WFI3 节点详情抽屉中关联 PR 区块位于产物之前', async ({ page }) => {
    const { env, instance } = await setupSeven(page, 'wfi3')
    const [n1] = instance.nodes
    await seedInstance(instance.id, {
      [`blackboard.${n1.id}-节点1-产物-说明`]: '节点产物内容',
    })
    await seedPullRequestLink(instance.id, {
      nodeId: n1.id,
      nodeKey: 'n1',
      pullRequestId: 'acme/repo#77',
      prUrl: 'https://github.com/acme/repo/pull/77',
    })

    await openGraph(page, instance.id)
    await page.locator(nodeCard(n1.id)).getByRole('button', { name: '节点1 详情' }).click()

    const drawer = page.getByTestId('node-detail-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('关联 Pull Request')
    await expect(drawer).toContainText('产物')

    const prBeforeArtifact = await drawer.evaluate((element) => {
      const titles = Array.from(element.querySelectorAll('div'))
        .filter((el) => el.className.includes('font-medium'))
        .map((el) => el.textContent ?? '')
      const prIndex = titles.findIndex((text) => text.includes('关联 Pull Request'))
      const artifactIndex = titles.findIndex((text) => /^产物（\d+）$/.test(text.trim()))
      return prIndex >= 0 && artifactIndex >= 0 && prIndex < artifactIndex
    })
    expect(prBeforeArtifact).toBe(true)

    env.controllers.forEach((controller) => controller.disconnect())
  })
})
