import { describe, it, expect, beforeAll } from 'vitest';
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

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  purpose: string;
}

// 说明：控制面（cloud-controller）由 Aspire 以 K8S_ENABLED=false 启动（InMemoryK8sClient）。
// 因此 start 后容器处于 CREATING/CONNECTING（无真实工作容器回连），destroy 幂等返回 true。

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
});
