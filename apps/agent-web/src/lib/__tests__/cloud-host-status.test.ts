import { describe, expect, it } from 'vitest';
import {
  CLOUD_HOST_STATUS_LABELS,
  cloudHostStatusDotClass,
  cloudHostStatusLabel,
  cloudHostStatusText,
} from '../../components/cloud-host/cloud-host-status';
import { CLOUD_HOST_STATUS_MATRIX } from '../status-matrix';

describe('云电脑状态矩阵接入（T-CH-STATUS）', () => {
  it('五态文案/圆点/徽标全部来自 Phase 1 状态矩阵', () => {
    const statuses = ['STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED'] as const;
    for (const status of statuses) {
      expect(CLOUD_HOST_STATUS_LABELS[status]).toBe(CLOUD_HOST_STATUS_MATRIX[status].label);
      expect(cloudHostStatusDotClass(status)).toBe(CLOUD_HOST_STATUS_MATRIX[status].dot);
      expect(CLOUD_HOST_STATUS_MATRIX[status].badge).toContain('bg-');
    }
    expect(cloudHostStatusLabel('RUNNING')).toBe('运行中');
    expect(cloudHostStatusDotClass('FAILED')).toContain('bg-destructive');
  });

  it('storageRestoring 追加文案保持（仅 STARTING 追加）', () => {
    expect(cloudHostStatusText({ status: 'STARTING', storageRestoring: true })).toBe('启动中（正在恢复数据）');
    expect(cloudHostStatusText({ status: 'STARTING', storageRestoring: false })).toBe('启动中');
    expect(cloudHostStatusText({ status: 'RUNNING', storageRestoring: true })).toBe('运行中');
    expect(cloudHostStatusText(null)).toBe('');
  });

  it('未知状态回退中性灰（矩阵兜底）', () => {
    expect(cloudHostStatusDotClass('UNKNOWN' as never)).toContain('bg-muted-foreground');
  });
});
