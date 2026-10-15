import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { BASE_IMAGES } from '@/graphql/queries'
import {
  CREATE_BASE_IMAGE,
  UPDATE_BASE_IMAGE,
  DELETE_BASE_IMAGE,
} from '@/graphql/mutations'
import type { BaseImageData, BaseImageInputData, GetBaseImagesQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { QueryError } from '@/components/ui/query-error'
import BaseImageTable from '@/components/base-images/BaseImageTable'
import BaseImageFormDialog from '@/components/base-images/BaseImageFormDialog'
import DeleteConfirmDialog from '@/components/base-images/DeleteConfirmDialog'

export default function BaseImagePage() {
  const { data, loading, error, refetch } = useQuery<GetBaseImagesQuery>(BASE_IMAGES)
  const [createBaseImage] = useMutation(CREATE_BASE_IMAGE)
  const [updateBaseImage] = useMutation(UPDATE_BASE_IMAGE)
  const [deleteBaseImage] = useMutation(DELETE_BASE_IMAGE)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<BaseImageData | null>(null)
  const [deleting, setDeleting] = useState<BaseImageData | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)

  const images = data?.baseImages ?? []

  const handleCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const handleEdit = (image: BaseImageData) => {
    setEditing(image)
    setFormOpen(true)
  }

  const handleSave = async (input: BaseImageInputData) => {
    if (editing) {
      await updateBaseImage({
        variables: { id: editing.id, input },
        refetchQueries: [BASE_IMAGES],
      })
    } else {
      await createBaseImage({
        variables: { input },
        refetchQueries: [BASE_IMAGES],
      })
    }
    setEditing(null)
  }

  const handleDeleteConfirm = async () => {
    if (!deleting) return
    setDeletingBusy(true)
    try {
      await deleteBaseImage({
        variables: { id: deleting.id },
        refetchQueries: [BASE_IMAGES],
      })
      setDeleting(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    } finally {
      setDeletingBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-medium text-foreground">基础镜像</h1>
        <Button size="sm" onClick={handleCreate}>
          新建基础镜像
        </Button>
      </div>

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : (
        <BaseImageTable
          images={images}
          onEdit={handleEdit}
          onDelete={(image) => setDeleting(image)}
        />
      )}

      <BaseImageFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initialData={editing}
        onSave={handleSave}
      />

      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title="删除基础镜像"
        description={`确定要删除基础镜像「${deleting?.name ?? ''}」吗？此操作不可撤销。`}
        onConfirm={handleDeleteConfirm}
        loading={deletingBusy}
      />
    </div>
  )
}
