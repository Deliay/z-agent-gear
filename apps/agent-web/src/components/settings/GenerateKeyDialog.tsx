import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import type { CreateControllerKeyMutation } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const CREATE_KEY = gql`
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key {
        id
        name
        type
        keyPrefix
        status
        createdAt
      }
      rawKey
    }
  }
`

interface GenerateKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerated: (rawKey: string) => void
}

export default function GenerateKeyDialog({ open, onOpenChange, onGenerated }: GenerateKeyDialogProps) {
  const [name, setName] = useState('')
  const [createKey, { loading }] = useMutation<CreateControllerKeyMutation>(CREATE_KEY)

  const handleGenerate = async () => {
    if (!name.trim()) return

    const { data } = await createKey({
      variables: { input: { name: name.trim(), type: 'local' } },
    })

    if (data?.createControllerKey?.rawKey) {
      onGenerated(data.createControllerKey.rawKey)
      setName('')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>生成控制器 Key</DialogTitle>
          <DialogDescription>
            为你的控制器创建一个新的 Key。Key 仅在创建时显示一次。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key-name">名称</Label>
            <Input
              id="key-name"
              placeholder="例如：我的开发机"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleGenerate} disabled={loading || !name.trim()}>
            {loading ? '生成中...' : '生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
