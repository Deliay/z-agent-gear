import ProviderSection from '@/components/providers/ProviderSection'
import ModelSection from '@/components/models/ModelSection'
import ModelRenameRecordsPanel from '@/components/models/ModelRenameRecordsPanel'
import ModelPricingSection from '@/components/billing/ModelPricingSection'

export default function ModelConfigPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground">模型配置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理模型供应商、可用模型与计费单价；变更可实时下发至云电脑。
        </p>
      </div>
      <ProviderSection />
      <ModelSection />
      <ModelRenameRecordsPanel />
      <ModelPricingSection />
    </div>
  )
}
