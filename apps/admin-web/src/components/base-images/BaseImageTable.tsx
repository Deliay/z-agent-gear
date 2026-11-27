import { PencilIcon, Trash2Icon, Boxes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateTime } from '@/lib/format'
import type { BaseImageData } from '@/graphql/types'
import * as T from '@/lib/table-styles'

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
    <div className={T.TABLE_CONTAINER_CLASS}>
      <table className={T.TABLE_CLASS}>
        <thead className={T.TABLE_HEAD_CLASS}>
          <tr>
            <th className={T.TABLE_HEAD_CELL_CLASS}>名称</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>描述</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>更新时间</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>操作</th>
          </tr>
        </thead>
        <tbody>
          {images.map((image) => (
            <tr key={image.id} className={T.TABLE_ROW_CLASS}>
              <td className={T.TABLE_CELL_STRONG_CLASS}>{image.name}</td>
              <td className={`max-w-md truncate ${T.TABLE_CELL_MUTED_CLASS}`}>
                {image.description || '-'}
              </td>
              <td className={T.TABLE_CELL_MUTED_CLASS}>
                {formatDateTime(image.updatedAt)}
              </td>
              <td className={T.TABLE_CELL_CLASS}>
                <div className={T.TABLE_ACTION_CLASS}>
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
