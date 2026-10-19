import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { RECHARGE_BILLING_ACCOUNT } from '@/graphql/mutations'
import { ADMIN_BILLING_ACCOUNTS } from '@/graphql/queries'
import type { BillingAccountData } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface Props {
  account: BillingAccountData | null
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

export default function RechargeDialog({ account, open, onClose, onSuccess }: Props) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [recharge, { loading }] = useMutation(RECHARGE_BILLING_ACCOUNT)

  useEffect(() => {
    if (open) {
      setAmount('')
      setNote('')
    }
  }, [open])

  const submit = async () => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('充值金额必须为正数')
      return
    }
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      toast.error('充值金额最多支持 0.01 credits 精度')
      return
    }
    if (!account) return
    try {
      await recharge({
        variables: { accountId: account.id, amount: value, note: note || null },
        refetchQueries: [ADMIN_BILLING_ACCOUNTS],
      })
      toast.success('充值成功')
      onSuccess?.()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '充值失败')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>充值</DialogTitle>
          <DialogDescription>
            {account ? `目标账户：${account.ownerName}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm">金额（credits，0.01 精度）</span>
            <Input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如 100.00" />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">备注</span>
            <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={submit} disabled={loading}>
            确认充值
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
