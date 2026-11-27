import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdminCloudSpecData, AdminCloudSpecInputData } from '@/graphql/types';
import {
  isUnlimitedResources,
  mapSpecError,
  SPEC_MAX_CPU,
  SPEC_MAX_EPHEMERAL_STORAGE_GI,
  SPEC_MAX_MEMORY_GI,
  SPEC_WHITELIST_MAX_TENANTS,
  validateSpecForm,
} from '@/lib/cloud-host-spec';
import TenantWhitelistPicker from './TenantWhitelistPicker';

interface SpecFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: AdminCloudSpecData | null;
  onSave: (input: AdminCloudSpecInputData) => Promise<void>;
}

export default function SpecFormDialog({
  open,
  onOpenChange,
  initialData,
  onSave,
}: SpecFormDialogProps) {
  const [name, setName] = useState('');
  const [cpu, setCpu] = useState('0');
  const [memoryGi, setMemoryGi] = useState('0');
  const [ephemeralStorageGi, setEphemeralStorageGi] = useState('0');
  const [whitelistEnabled, setWhitelistEnabled] = useState(true);
  const [whitelistTouched, setWhitelistTouched] = useState(false);
  const [allowedTenantIds, setAllowedTenantIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initialData) {
      setName(initialData.name);
      setCpu(String(initialData.cpu));
      setMemoryGi(String(initialData.memoryGi));
      setEphemeralStorageGi(String(initialData.ephemeralStorageGi));
      setWhitelistEnabled(initialData.whitelistEnabled);
      setAllowedTenantIds(initialData.allowedTenantIds);
      return;
    }
    // 新建：三项默认 0（0C 0G 不限制规格），白名单默认开启且空名单 = 无租户可见
    setName('');
    setCpu('0');
    setMemoryGi('0');
    setEphemeralStorageGi('0');
    setWhitelistEnabled(true);
    setAllowedTenantIds([]);
    setWhitelistTouched(false);
  }, [open, initialData]);

  // 新建时仅「全 0（不限制）」默认开启白名单；改成普通组合后自动关闭（用户手动切换后不再自动改）。
  useEffect(() => {
    if (!open || initialData || whitelistTouched) return;
    const allZero = Number(cpu) === 0 && Number(memoryGi) === 0 && Number(ephemeralStorageGi) === 0;
    setWhitelistEnabled(allZero);
  }, [open, initialData, whitelistTouched, cpu, memoryGi, ephemeralStorageGi]);

  const errors = validateSpecForm({ name, cpu, memoryGi, ephemeralStorageGi });
  const whitelistTooLarge = allowedTenantIds.length > SPEC_WHITELIST_MAX_TENANTS;
  const isValid = !errors.name && !errors.resources && !whitelistTooLarge;

  // 提交时白名单关闭 → 名单置空（与服务端口径一致，避免「隐藏的白名单」）
  const effectiveAllowedTenantIds = whitelistEnabled ? allowedTenantIds : [];

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        cpu: Number(cpu.trim()),
        memoryGi: Number(memoryGi.trim()),
        ephemeralStorageGi: Number(ephemeralStorageGi.trim()),
        whitelistEnabled,
        allowedTenantIds: effectiveAllowedTenantIds,
      });
      onOpenChange(false);
    } catch (err) {
      setError(mapSpecError(err instanceof Error ? err.message : ''));
    } finally {
      setSaving(false);
    }
  };

  const previewUnlimited = isUnlimitedResources(
    Number(cpu.trim()),
    Number(memoryGi.trim()),
    Number(ephemeralStorageGi.trim()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initialData ? '编辑容器规格' : '新建容器规格'}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="spec-name">名称</Label>
            <Input
              id="spec-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如: 4C 8G 20G"
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          <div className="min-w-0 space-y-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="spec-cpu">CPU（核）</Label>
                <Input
                  id="spec-cpu"
                  type="number"
                  min={0}
                  max={SPEC_MAX_CPU}
                  value={cpu}
                  onChange={(event) => setCpu(event.target.value)}
                  aria-invalid={Boolean(errors.resources)}
                />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="spec-memory">内存（GiB）</Label>
                <Input
                  id="spec-memory"
                  type="number"
                  min={0}
                  max={SPEC_MAX_MEMORY_GI}
                  value={memoryGi}
                  onChange={(event) => setMemoryGi(event.target.value)}
                  aria-invalid={Boolean(errors.resources)}
                />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="spec-ephemeral">临时存储（GiB）</Label>
                <Input
                  id="spec-ephemeral"
                  type="number"
                  min={0}
                  max={SPEC_MAX_EPHEMERAL_STORAGE_GI}
                  value={ephemeralStorageGi}
                  onChange={(event) => setEphemeralStorageGi(event.target.value)}
                  aria-invalid={Boolean(errors.resources)}
                />
              </div>
            </div>
            {errors.resources ? (
              <p className="text-xs text-destructive">{errors.resources}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {previewUnlimited
                  ? '三项全 0 = 不限制容器，随时可能会被系统销毁（每小时费用 0）。'
                  : `普通规格三项均须大于 0，上限 CPU ${SPEC_MAX_CPU}、内存 ${SPEC_MAX_MEMORY_GI} GiB、临时存储 ${SPEC_MAX_EPHEMERAL_STORAGE_GI} GiB。`}
              </p>
            )}
          </div>

          <div className="min-w-0 space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="spec-whitelist-enabled"
                aria-label="开启白名单"
                checked={whitelistEnabled}
                onCheckedChange={(value) => {
                  setWhitelistTouched(true);
                  setWhitelistEnabled(value === true);
                }}
              />
              <Label
                className="cursor-pointer"
                onClick={() => {
                  setWhitelistTouched(true);
                  setWhitelistEnabled((value) => !value);
                }}
              >
                开启白名单
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              未开启时全部租户可见；开启但未选任何租户时，没有任何租户可见该规格。
            </p>
            {whitelistEnabled && (
              <TenantWhitelistPicker
                selectedIds={allowedTenantIds}
                onChange={setAllowedTenantIds}
              />
            )}
            {whitelistTooLarge && (
              <p className="text-xs text-destructive">
                白名单最多选择 {SPEC_WHITELIST_MAX_TENANTS} 个租户
              </p>
            )}
          </div>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
