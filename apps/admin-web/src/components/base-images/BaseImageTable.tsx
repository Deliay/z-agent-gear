import { PencilIcon, Trash2Icon, Boxes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateTime } from '@/lib/format'
import type { BaseImageData } from '@/graphql/types'

interface BaseImageTableProps {
  images: BaseImageData[]
  onEdit: (image: BaseImageData) => void
  onDelete: (image: BaseImageData) => void
}

export default function BaseImageTable({ images, onEdit, onDelete }: BaseImageTableProps) {
  if (images.length === 0) {
    return (
      <div className="rounded-lg border border-dashed">
        <EmptyState
          icon={Boxes}
          title="暂无基础镜像"
          description="点击「新建基础镜像」录入 Dockerfile，供后续构建使用"
        />
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-0 text-sm">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">名称</th>
            <th className="px-4 py-2 font-medium">描述</th>
            <th className="px-4 py-2 font-medium">更新时间</th>
            <th className="px-4 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {images.map((image) => (
            <tr key={image.id} className="border-t">
              <td className="px-4 py-3 font-medium text-foreground">{image.name}</td>
              <td className="max-w-md truncate px-4 py-3 text-muted-foreground">
                {image.description || '-'}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatDateTime(image.updatedAt)}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`编辑 ${image.name}`}
                    onClick={() => onEdit(image)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost-danger"
                    size="icon-sm"
                    aria-label={`删除 ${image.name}`}
                    onClick={() => onDelete(image)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
