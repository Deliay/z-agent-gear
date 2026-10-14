import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';

const LIST = `
  query AdminCloudContainers {
    adminCloudContainers {
      id
      name
      status
      purpose
      refId
      createdAt
      connectedAt
      exitedAt
      exitReason
    }
  }
`;

const START = `
  mutation AdminStartCloudContainer($purpose: CloudContainerPurpose!) {
    adminStartCloudContainer(purpose: $purpose) {
      id
      name
      status
      purpose
      createdAt
    }
  }
`;

const DESTROY = `
  mutation AdminDestroyCloudContainer($id: ID!) {
    adminDestroyCloudContainer(id: $id)
  }
`;

const CONTROL_PLANE = `
  query AdminCloudContainerControlPlane {
    adminCloudContainerControlPlane { online message }
  }
`;

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  purpose: string;
}

// 说明：控制面（cloud-controller）由 Aspire 以 K8S_ENABLED=false 启动（InMemoryK8sClient）。
// 因此 start 后容器处于 CREATING/CONNECTING（无真实工作容器回连），destroy 幂等返回 true。

/** 直接把容器置为在线（模拟真实回连），用于验证销毁宽限期链路；需要 MONGODB_URI。 */
async function forceContainerOnline(id: string): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) return false;
  const result = await db
    .collection('cloudcontainers')
    .updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status: 'online', connectedAt: new Date() } });
  return result.matchedCount > 0;
}

describe('Admin Cloud Container API', () => {
  let token = '';

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  it('T-IA5: rejects anonymous list / start / destroy', async () => {
    const list = await adminGql(LIST);
    expect(list.errors?.[0].message).toBe('Not authenticated');

    const start = await adminGql(START, { purpose: 'IDLE' });
    expect(start.errors?.[0].message).toBe('Not authenticated');

    const destroy = await adminGql(DESTROY, { id: 'x' });
    expect(destroy.errors?.[0].message).toBe('Not authenticated');
  });

  it('T-IA1: lists cloud containers via the control plane', async () => {
    const body = await adminGql<{ adminCloudContainers: ContainerNode[] }>(LIST, undefined, token);
    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data!.adminCloudContainers)).toBe(true);
  });

  it('T-IA2: reports control plane online=true on the control-plane field', async () => {
    const body = await adminGql<{ adminCloudContainerControlPlane: { online: boolean; message: string | null } }>(
      CONTROL_PLANE,
      undefined,
      token,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.adminCloudContainerControlPlane.online).toBe(true);
  });

  it('T-IA6: rejects non-idle purpose with explicit message', async () => {
    const body = await adminGql(START, { purpose: 'WORKFLOW' }, token);
    expect(body.errors?.[0].message).toBe('该任务类型暂未开放');
  });

  it('T-IA3/T-IA4: starts an idle container then destroys it', async () => {
    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
    expect(started.errors).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    expect(container.purpose).toBe('IDLE');
    expect(['CREATING', 'CONNECTING']).toContain(container.status);

    const listed = await adminGql<{ adminCloudContainers: ContainerNode[] }>(LIST, undefined, token);
    expect(listed.data!.adminCloudContainers.some((c) => c.id === container.id)).toBe(true);

    const destroyed = await adminGql<{ adminDestroyCloudContainer: boolean }>(DESTROY, { id: container.id }, token);
    expect(destroyed.errors).toBeUndefined();
    expect(destroyed.data!.adminDestroyCloudContainer).toBe(true);

    const after = await adminGql<{ adminCloudContainers: Array<{ id: string; status: string }> }>(LIST, undefined, token);
    const row = after.data!.adminCloudContainers.find((c) => c.id === container.id);
    expect(row?.status).toBe('EXITED');
  });

  it(
    'P0-1: online container destroy survives the shutdown grace without a false timeout',
    async () => {
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
      const id = started.data!.adminStartCloudContainer.id;

      const forced = await forceContainerOnline(id);
      if (!forced) {
        console.warn('skip P0-1: MONGODB_URI unavailable');
        return;
      }

      const startedAt = Date.now();
      const destroyed = await adminGql<{ adminDestroyCloudContainer: boolean }>(DESTROY, { id }, token);
      const elapsed = Date.now() - startedAt;

      expect(destroyed.errors).toBeUndefined();
      expect(destroyed.data!.adminDestroyCloudContainer).toBe(true);
      // cloud-controller 对在线容器等待 shutdown 宽限期（约 10s）后才响应
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      // admin-api 销毁专用超时（30s）内完成，未误报 CONTROL_PLANE_UNAVAILABLE
      expect(elapsed).toBeLessThan(29000);
    },
    40000,
  );
});
