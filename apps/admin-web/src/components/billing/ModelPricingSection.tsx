import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { ADMIN_MODELS } from '@/graphql/queries'
import { UPDATE_MODEL_PRICING } from '@/graphql/mutations'
import type { AdminModelData, GetAdminModelsQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Draft {
  inputPerMillion: string
  cachedInputPerMillion: string
  outputPerMillion: string
  isBillable: boolean
}

function draftOf(model: AdminModelData): Draft {
  return {
    inputPerMillion: String(model.pricing?.inputPerMillion ?? 0),
    cachedInputPerMillion: String(model.pricing?.cachedInputPerMillion ?? 0),
    outputPerMillion: String(model.pricing?.outputPerMillion ?? 0),
    isBillable: model.pricing?.isBillable ?? true,
  }
}

/** 模型定价编辑（输入/缓存输入/输出 每百万 token + 计费开关）。 */
export default function ModelPricingSection() {
  const { data, refetch } = useQuery<GetAdminModelsQuery>(ADMIN_MODELS)
  const [updatePricing] = useMutation(UPDATE_MODEL_PRICING)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const models = useMemo(() => data?.adminModels ?? [], [data])

  const draftFor = (model: AdminModelData): Draft => drafts[model.id] ?? draftOf(model)

  const patch = (id: string, model: AdminModelData, value: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(model), ...value } }))
  }

  const save = async (model: AdminModelData) => {
    const draft = draftFor(model)
    const values = {
      inputPerMillion: Number(draft.inputPerMillion),
      cachedInputPerMillion: Number(draft.cachedInputPerMillion),
      outputPerMillion: Number(draft.outputPerMillion),
      isBillable: draft.isBillable,
    }
    const numeric = [values.inputPerMillion, values.cachedInputPerMillion, values.outputPerMillion]
    if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
      toast.error('单价必须为非负数')
      return
    }
    setSavingId(model.id)
    try {
      await updatePricing({ variables: { modelId: model.id, pricing: values } })
      await refetch()
      setDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
      toast.success('模型定价已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型定价（credits / 百万 token）</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无模型</p>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">模型</th>
                <th className="py-2 pr-3 font-medium">输入</th>
                <th className="py-2 pr-3 font-medium">缓存输入</th>
                <th className="py-2 pr-3 font-medium">输出</th>
                <th className="py-2 pr-3 font-medium">计费</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const draft = draftFor(model)
                return (
                  <tr key={model.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{model.name}</td>
                    <td className="py-2 pr-3">
                      <Input
                        className="w-24"
                        value={draft.inputPerMillion}
                        onChange={(event) => patch(model.id, model, { inputPerMillion: event.target.value })}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        className="w-24"
                        value={draft.cachedInputPerMillion}
                        onChange={(event) =>
                          patch(model.id, model, { cachedInputPerMillion: event.target.value })
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        className="w-24"
                        value={draft.outputPerMillion}
                        onChange={(event) => patch(model.id, model, { outputPerMillion: event.target.value })}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        checked={draft.isBillable}
                        onChange={(event) => patch(model.id, model, { isBillable: event.target.checked })}
                        aria-label={`${model.name} 计费开关`}
                      />
                    </td>
                    <td className="py-2">
                      <Button size="sm" onClick={() => save(model)} disabled={savingId === model.id}>
                        保存
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
