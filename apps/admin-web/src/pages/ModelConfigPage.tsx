import ProviderSection from '@/components/providers/ProviderSection'
import ModelSection from '@/components/models/ModelSection'

export default function ModelConfigPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="font-heading text-xl font-medium text-foreground">模型配置</h1>
      <ProviderSection />
      <ModelSection />
    </div>
  )
}
