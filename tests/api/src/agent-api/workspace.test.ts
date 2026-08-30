import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name }
      rawKey
    }
  }
`;

const WORKSPACES_QUERY = `
  query ControllerWorkspaces($controllerId: ID!) {
    controllerWorkspaces(controllerId: $controllerId) {
      id userId controllerId name path isEnabled defaultBranch createdAt updatedAt
    }
  }
`;

const ALL_WORKSPACES_QUERY = `
  query AllWorkspaces {
    workspaces {
      id userId controllerId name path isEnabled defaultBranch createdAt updatedAt
    }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id userId controllerId name path isEnabled createdAt updatedAt
    }
  }
`;

const DELETE_WORKSPACE = `
  mutation DeleteWorkspace($id: ID!) {
    deleteWorkspace(id: $id)
  }
`;

const CLEAR_WORKSPACES = `
  mutation ClearWorkspaces($controllerId: ID!) {
    clearWorkspaces(controllerId: $controllerId)
  }
`;

const TOGGLE_WORKSPACE = `
  mutation ToggleWorkspace($id: ID!) {
    toggleWorkspace(id: $id) {
      id isEnabled
    }
  }
`;

const BROWSE_FOLDER = `
  query BrowseFolder($controllerId: ID!, $path: String) {
    browseFolder(controllerId: $controllerId, path: $path) {
      name path isDirectory
    }
  }
`;

const GET_HOME_DIRECTORY = `
  query GetHomeDirectory($controllerId: ID!) {
    getHomeDirectory(controllerId: $controllerId)
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session {
        id userId controllerId controllerName acpServerType status
        externalSessionId cwd createdAt updatedAt endedAt
      }
    }
  }
`;

const DETECT_GIT_REPO = `
  query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
    detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) {
      isGitRepo
      currentBranch
      branches
      defaultBranch
    }
  }
`;

const INIT_GIT_REPO = `
  mutation InitGitRepo($controllerId: ID!, $workspaceId: ID!) {
    initGitRepo(controllerId: $controllerId, workspaceId: $workspaceId)
  }
`;

const SET_WORKSPACE_DEFAULT_BRANCH = `
  mutation SetWorkspaceDefaultBranch($id: ID!, $defaultBranch: String!) {
    setWorkspaceDefaultBranch(id: $id, defaultBranch: $defaultBranch) {
      id defaultBranch
    }
  }
`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

let authToken = '';
let rawKey = '';
let controllerId = '';

async function signup(): Promise<string> {
  const uid = `ws_${Date.now().toString(36)}`;
  const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
  const body = await res.json();
  return body.data?.signup?.token ?? '';
}

async function createKeyAndRegisterController(token: string): Promise<{ rawKey: string; controllerId: string }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `ws-key-${Date.now()}`, type: 'local' } },
    token,
  );
  const keyBody = await keyRes.json();
  const key = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key, hostname: 'ws-test-host', version: '2.0.0' });
  const regData = await registered;
  client.disconnect();

  return { rawKey: key, controllerId: regData.controllerId };
}

describe('Controller Workspace API', () => {
  beforeAll(async () => {
    authToken = await signup();
    expect(authToken).toBeTruthy();

    const ctrl = await createKeyAndRegisterController(authToken);
    rawKey = ctrl.rawKey;
    controllerId = ctrl.controllerId;
  });

  describe('queries without auth', () => {
    it('should reject controllerWorkspaces query without token', async () => {
      const res = await gqlRequest(WORKSPACES_QUERY, { controllerId });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject workspaces query without token', async () => {
      const res = await gqlRequest(ALL_WORKSPACES_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject browseFolder query without token', async () => {
      const res = await gqlRequest(BROWSE_FOLDER, { controllerId });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject getHomeDirectory query without token', async () => {
      const res = await gqlRequest(GET_HOME_DIRECTORY, { controllerId });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('mutations without auth', () => {
    it('should reject createWorkspace without auth', async () => {
      const res = await gqlRequest(CREATE_WORKSPACE, {
        input: { controllerId, path: '/tmp/test' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject deleteWorkspace without auth', async () => {
      const res = await gqlRequest(DELETE_WORKSPACE, { id: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject clearWorkspaces without auth', async () => {
      const res = await gqlRequest(CLEAR_WORKSPACES, { controllerId });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject toggleWorkspace without auth', async () => {
      const res = await gqlRequest(TOGGLE_WORKSPACE, { id: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('createWorkspace', () => {
    it('should create a new workspace', async () => {
      const res = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/workspace-test' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createWorkspace.id).toBeDefined();
      expect(body.data.createWorkspace.name).toBe('workspace-test');
      expect(body.data.createWorkspace.path).toBe('/tmp/workspace-test');
      expect(body.data.createWorkspace.isEnabled).toBe(true);
      expect(body.data.createWorkspace.controllerId).toBe(controllerId);
    });

    it('should reject duplicate workspace path', async () => {
      await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/dup-test' } },
        authToken,
      );
      const res = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/dup-test' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace already exists');
    });

    it('should reject workspace for non-existent controller', async () => {
      const res = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: '000000000000000000000000', path: '/tmp/test' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });

  describe('controllerWorkspaces query', () => {
    it('should return workspaces list', async () => {
      const res = await gqlRequest(WORKSPACES_QUERY, { controllerId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.controllerWorkspaces)).toBe(true);
    });

    it('should return workspaces sorted by name', async () => {
      const res = await gqlRequest(WORKSPACES_QUERY, { controllerId }, authToken);
      const body = await res.json();
      const workspaces = body.data.controllerWorkspaces;
      if (workspaces.length > 1) {
        for (let i = 1; i < workspaces.length; i++) {
          expect(workspaces[i].name.localeCompare(workspaces[i - 1].name)).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('workspaces query', () => {
    it('should return all workspaces across controllers', async () => {
      const res = await gqlRequest(ALL_WORKSPACES_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.workspaces)).toBe(true);
    });

    it('should include workspaces from previous tests', async () => {
      const res = await gqlRequest(ALL_WORKSPACES_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.data.workspaces.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('toggleWorkspace', () => {
    it('should toggle workspace enabled status', async () => {
      const createRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/toggle-test' } },
        authToken,
      );
      const createBody = await createRes.json();
      const workspaceId = createBody.data.createWorkspace.id;
      expect(createBody.data.createWorkspace.isEnabled).toBe(true);

      const toggleRes = await gqlRequest(TOGGLE_WORKSPACE, { id: workspaceId }, authToken);
      const toggleBody = await toggleRes.json();
      expect(toggleBody.errors).toBeUndefined();
      expect(toggleBody.data.toggleWorkspace.isEnabled).toBe(false);

      const toggleRes2 = await gqlRequest(TOGGLE_WORKSPACE, { id: workspaceId }, authToken);
      const toggleBody2 = await toggleRes2.json();
      expect(toggleBody2.data.toggleWorkspace.isEnabled).toBe(true);
    });

    it('should reject toggling non-existent workspace', async () => {
      const res = await gqlRequest(
        TOGGLE_WORKSPACE,
        { id: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });

  describe('deleteWorkspace', () => {
    it('should delete a workspace', async () => {
      const createRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/delete-test' } },
        authToken,
      );
      const createBody = await createRes.json();
      const workspaceId = createBody.data.createWorkspace.id;

      const deleteRes = await gqlRequest(DELETE_WORKSPACE, { id: workspaceId }, authToken);
      const deleteBody = await deleteRes.json();
      expect(deleteBody.errors).toBeUndefined();
      expect(deleteBody.data.deleteWorkspace).toBe(true);

      const queryRes = await gqlRequest(WORKSPACES_QUERY, { controllerId }, authToken);
      const queryBody = await queryRes.json();
      const found = queryBody.data.controllerWorkspaces.find((w: { id: string }) => w.id === workspaceId);
      expect(found).toBeUndefined();
    });

    it('should return false for non-existent workspace', async () => {
      const res = await gqlRequest(
        DELETE_WORKSPACE,
        { id: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteWorkspace).toBe(false);
    });
  });

  describe('clearWorkspaces', () => {
    it('should clear all workspaces for a controller', async () => {
      await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/clear-test-1' } },
        authToken,
      );
      await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId, path: '/tmp/clear-test-2' } },
        authToken,
      );

      const clearRes = await gqlRequest(CLEAR_WORKSPACES, { controllerId }, authToken);
      const clearBody = await clearRes.json();
      expect(clearBody.errors).toBeUndefined();
      expect(clearBody.data.clearWorkspaces).toBe(true);

      const queryRes = await gqlRequest(WORKSPACES_QUERY, { controllerId }, authToken);
      const queryBody = await queryRes.json();
      expect(queryBody.data.controllerWorkspaces).toEqual([]);
    });
  });
});

describe('Folder Browser API', () => {
  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }
  });

  describe('browseFolder', () => {
    it('should reject browseFolder for non-existent controller', async () => {
      const res = await gqlRequest(
        BROWSE_FOLDER,
        { controllerId: '000000000000000000000000', path: '/tmp' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject browseFolder for offline controller', async () => {
      // Create a controller that is not online
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `offline-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const offlineRawKey = keyBody.data.createControllerKey.rawKey;

      // Register and immediately disconnect
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: offlineRawKey, hostname: 'offline-host', version: '2.0.0' });
      const regData = await registered;
      client.disconnect();

      await new Promise((r) => setTimeout(r, 300));

      const res = await gqlRequest(
        BROWSE_FOLDER,
        { controllerId: regData.controllerId, path: '/tmp' },
        authToken,
      );
      const body = await res.json();
      // Controller is offline after disconnect, so should get an error
      expect(body.errors).toBeDefined();
    });
  });

  describe('getHomeDirectory', () => {
    it('should reject getHomeDirectory for non-existent controller', async () => {
      const res = await gqlRequest(
        GET_HOME_DIRECTORY,
        { controllerId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });
  });

  describe('browseFolder via WebSocket protocol', () => {
    it('should return directory entries from controller', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `browse-ok-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'browse-ok', version: '2.0.0' });
      const regData = await registered;

      const fsBrowse = waitForEvent<{ requestId: string; path: string | null }>(client, 'fs:browse', 10000);
      const responsePromise = gqlRequest(
        BROWSE_FOLDER,
        { controllerId: regData.controllerId, path: '/home/user' },
        authToken,
      );

      const browseData = await fsBrowse;
      expect(browseData.path).toBe('/home/user');

      client.emit('fs:browse:result', {
        requestId: browseData.requestId,
        entries: [
          { name: 'Documents', path: '/home/user/Documents', isDirectory: true },
          { name: 'file.txt', path: '/home/user/file.txt', isDirectory: false },
          { name: 'Pictures', path: '/home/user/Pictures', isDirectory: true },
        ],
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.browseFolder).toHaveLength(3);
      expect(body.data.browseFolder[0]).toEqual({ name: 'Documents', path: '/home/user/Documents', isDirectory: true });
      expect(body.data.browseFolder[1]).toEqual({ name: 'file.txt', path: '/home/user/file.txt', isDirectory: false });
      expect(body.data.browseFolder[2]).toEqual({ name: 'Pictures', path: '/home/user/Pictures', isDirectory: true });

      client.disconnect();
    }, 30000);

    it('should return empty array when controller returns no entries', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `browse-empty-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'browse-empty', version: '2.0.0' });
      const regData = await registered;

      const fsBrowse = waitForEvent<{ requestId: string }>(client, 'fs:browse', 10000);
      const responsePromise = gqlRequest(
        BROWSE_FOLDER,
        { controllerId: regData.controllerId, path: '/empty' },
        authToken,
      );

      const browseData = await fsBrowse;

      client.emit('fs:browse:result', {
        requestId: browseData.requestId,
        entries: [],
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.browseFolder).toEqual([]);

      client.disconnect();
    }, 30000);

    it('should use home directory when path is null', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `browse-null-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'browse-null', version: '2.0.0' });
      const regData = await registered;

      const fsBrowse = waitForEvent<{ requestId: string; path: string | null }>(client, 'fs:browse', 10000);
      const responsePromise = gqlRequest(
        BROWSE_FOLDER,
        { controllerId: regData.controllerId },
        authToken,
      );

      const browseData = await fsBrowse;
      expect(browseData.path).toBeNull();

      client.emit('fs:browse:result', {
        requestId: browseData.requestId,
        entries: [
          { name: 'Desktop', path: '/home/user/Desktop', isDirectory: true },
        ],
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.browseFolder).toHaveLength(1);

      client.disconnect();
    }, 30000);

    it('should return entries when path is root /', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `browse-root-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'browse-root', version: '2.0.0' });
      const regData = await registered;

      const fsBrowse = waitForEvent<{ requestId: string; path: string | null }>(client, 'fs:browse', 10000);
      const responsePromise = gqlRequest(
        BROWSE_FOLDER,
        { controllerId: regData.controllerId, path: '/' },
        authToken,
      );

      const browseData = await fsBrowse;
      expect(browseData.path).toBe('/');

      client.emit('fs:browse:result', {
        requestId: browseData.requestId,
        entries: [
          { name: 'home', path: '/home', isDirectory: true },
          { name: 'usr', path: '/usr', isDirectory: true },
          { name: 'etc', path: '/etc', isDirectory: true },
        ],
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.browseFolder).toHaveLength(3);
      expect(body.data.browseFolder[0].name).toBe('home');

      client.disconnect();
    }, 30000);
  });

  describe('getHomeDirectory via WebSocket protocol', () => {
    it('should return home directory path from controller', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `home-ok-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'home-ok', version: '2.0.0' });
      const regData = await registered;

      const fsHome = waitForEvent<{ requestId: string }>(client, 'fs:home', 10000);
      const responsePromise = gqlRequest(
        GET_HOME_DIRECTORY,
        { controllerId: regData.controllerId },
        authToken,
      );

      const homeData = await fsHome;
      expect(homeData.requestId).toBeDefined();

      client.emit('fs:home:result', {
        requestId: homeData.requestId,
        path: '/home/testuser',
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.getHomeDirectory).toBe('/home/testuser');

      client.disconnect();
    }, 30000);
  });
});

describe('Workspace Git Support', () => {
  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
    }
  });

  describe('detectGitRepo', () => {
    it('should reject detectGitRepo without auth', async () => {
      const res = await gqlRequest(DETECT_GIT_REPO, { controllerId: '000000000000000000000000', workspaceId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject detectGitRepo for non-existent controller', async () => {
      const res = await gqlRequest(
        DETECT_GIT_REPO,
        { controllerId: '000000000000000000000000', workspaceId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject detectGitRepo for non-existent workspace', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-detect-ws-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-detect-ws', version: '2.0.0' });
      const regData = await registered;

      const res = await gqlRequest(
        DETECT_GIT_REPO,
        { controllerId: regData.controllerId, workspaceId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace not found');
      client.disconnect();
    });

    it('should reject detectGitRepo for offline controller', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-offline-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'offline-host', version: '2.0.0' });
      const regData = await registered;
      client.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/git-offline-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();

      const res = await gqlRequest(
        DETECT_GIT_REPO,
        { controllerId: regData.controllerId, workspaceId: wsBody.data.createWorkspace.id },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller is offline');
    });

    it('should detect a valid git repo via WebSocket protocol', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-detect-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-detect-host', version: '2.0.0' });
      const regData = await registered;

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/git-repo-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();
      const workspaceId = wsBody.data.createWorkspace.id;

      const gitCheck = waitForEvent<{ requestId: string; path: string }>(client, 'git:check', 10000);
      const responsePromise = gqlRequest(DETECT_GIT_REPO, { controllerId: regData.controllerId, workspaceId }, authToken);

      const gitData = await gitCheck;
      expect(gitData.path).toBeDefined();

      client.emit('git:check:result', {
        requestId: gitData.requestId,
        success: true,
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main', 'develop', 'feature/test'],
        defaultBranch: 'main',
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.detectGitRepo.isGitRepo).toBe(true);
      expect(body.data.detectGitRepo.currentBranch).toBe('main');
      expect(body.data.detectGitRepo.branches).toEqual(['main', 'develop', 'feature/test']);
      expect(body.data.detectGitRepo.defaultBranch).toBe('main');

      client.disconnect();
    }, 30000);

    it('should detect non-git directory via WebSocket protocol', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-non-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-non-host', version: '2.0.0' });
      const regData = await registered;

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/not-a-repo-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();
      const workspaceId = wsBody.data.createWorkspace.id;

      const gitCheck = waitForEvent<{ requestId: string }>(client, 'git:check', 10000);
      const responsePromise = gqlRequest(DETECT_GIT_REPO, { controllerId: regData.controllerId, workspaceId }, authToken);

      const gitData = await gitCheck;

      client.emit('git:check:result', {
        requestId: gitData.requestId,
        success: true,
        isGitRepo: false,
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.detectGitRepo.isGitRepo).toBe(false);
      expect(body.data.detectGitRepo.currentBranch).toBeNull();
      expect(body.data.detectGitRepo.branches).toBeNull();
      expect(body.data.detectGitRepo.defaultBranch).toBeNull();

      client.disconnect();
    }, 30000);
  });

  describe('initGitRepo', () => {
    it('should reject initGitRepo without auth', async () => {
      const res = await gqlRequest(INIT_GIT_REPO, { controllerId: '000000000000000000000000', workspaceId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject initGitRepo for non-existent controller', async () => {
      const res = await gqlRequest(
        INIT_GIT_REPO,
        { controllerId: '000000000000000000000000', workspaceId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject initGitRepo for non-existent workspace', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-init-ws-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-init-ws', version: '2.0.0' });
      const regData = await registered;

      const res = await gqlRequest(
        INIT_GIT_REPO,
        { controllerId: regData.controllerId, workspaceId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace not found');
      client.disconnect();
    });

    it('should reject initGitRepo for offline controller', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-init-offline-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'offline-init', version: '2.0.0' });
      const regData = await registered;
      client.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/git-init-offline-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();

      const res = await gqlRequest(
        INIT_GIT_REPO,
        { controllerId: regData.controllerId, workspaceId: wsBody.data.createWorkspace.id },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller is offline');
    });

    it('should return true on successful git init via WebSocket protocol', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-init-ok-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-init-ok', version: '2.0.0' });
      const regData = await registered;

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/git-init-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();
      const workspaceId = wsBody.data.createWorkspace.id;

      const gitInit = waitForEvent<{ requestId: string }>(client, 'git:init', 10000);
      const responsePromise = gqlRequest(INIT_GIT_REPO, { controllerId: regData.controllerId, workspaceId }, authToken);

      const initData = await gitInit;
      expect(initData.requestId).toBeDefined();

      client.emit('git:init:result', {
        requestId: initData.requestId,
        success: true,
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.initGitRepo).toBe(true);

      client.disconnect();
    }, 30000);

    it('should return GraphQL error when git init fails via WebSocket protocol', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `git-init-fail-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'git-init-fail', version: '2.0.0' });
      const regData = await registered;

      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: regData.controllerId, path: `/tmp/git-init-fail-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();
      const workspaceId = wsBody.data.createWorkspace.id;

      const gitInit = waitForEvent<{ requestId: string }>(client, 'git:init', 10000);
      const responsePromise = gqlRequest(INIT_GIT_REPO, { controllerId: regData.controllerId, workspaceId }, authToken);

      const initData = await gitInit;

      client.emit('git:init:result', {
        requestId: initData.requestId,
        success: false,
        error: 'git command not found',
      });

      const res = await responsePromise;
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('git command not found');

      client.disconnect();
    }, 30000);
  });

  describe('setWorkspaceDefaultBranch', () => {
    let createdWorkspace: { id: string };

    beforeAll(async () => {
      const ctrl = await createKeyAndRegisterController(authToken);
      const wsRes = await gqlRequest(
        CREATE_WORKSPACE,
        { input: { controllerId: ctrl.controllerId, path: `/tmp/default-branch-test-${Date.now()}` } },
        authToken,
      );
      const wsBody = await wsRes.json();
      createdWorkspace = wsBody.data.createWorkspace;
    });

    it('should reject setWorkspaceDefaultBranch without auth', async () => {
      const res = await gqlRequest(SET_WORKSPACE_DEFAULT_BRANCH, { id: '000000000000000000000000', defaultBranch: 'main' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject setWorkspaceDefaultBranch for non-existent workspace', async () => {
      const res = await gqlRequest(
        SET_WORKSPACE_DEFAULT_BRANCH,
        { id: '000000000000000000000000', defaultBranch: 'main' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace not found');
    });

    it('should set defaultBranch on workspace', async () => {
      const res = await gqlRequest(
        SET_WORKSPACE_DEFAULT_BRANCH,
        { id: createdWorkspace.id, defaultBranch: 'main' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setWorkspaceDefaultBranch.id).toBe(createdWorkspace.id);
      expect(body.data.setWorkspaceDefaultBranch.defaultBranch).toBe('main');
    });

    it('should persist defaultBranch in workspace query', async () => {
      const res = await gqlRequest(WORKSPACES_QUERY, { controllerId: createdWorkspace.controllerId }, authToken);
      const body = await res.json();
      const ws = body.data.controllerWorkspaces.find((w: { id: string }) => w.id === createdWorkspace.id);
      expect(ws).toBeDefined();
      expect(ws.defaultBranch).toBe('main');
    });
  });
});

describe('Session Creation with WorkspaceId', () => {
  let workspaceId = '';

  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }

    // Create a workspace for testing
    const createRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: '/tmp/session-test' } },
      authToken,
    );
    const createBody = await createRes.json();
    workspaceId = createBody.data.createWorkspace.id;
  });

  describe('createSession with workspaceId', () => {
    it('should create session with workspaceId', async () => {
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.cwd).toBe('/tmp/session-test');
    });

    it('should reject createSession with invalid workspaceId', async () => {
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: '000000000000000000000000' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace not found');
    });

    it('should reject createSession without workspaceId', async () => {
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });
});

describe('createFolder mutation', () => {
  const CREATE_FOLDER = `
    mutation CreateFolder($controllerId: ID!, $parentPath: String!, $folderName: String!) {
      createFolder(controllerId: $controllerId, parentPath: $parentPath, folderName: $folderName) {
        name path isDirectory
      }
    }
  `;

  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }
  });

  it('should reject createFolder without auth', async () => {
    const res = await gqlRequest(CREATE_FOLDER, {
      controllerId: '000000000000000000000000',
      parentPath: '/tmp',
      folderName: 'new-folder',
    });
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('Not authenticated');
  });

  it('should reject createFolder for non-existent controller', async () => {
    const res = await gqlRequest(
      CREATE_FOLDER,
      { controllerId: '000000000000000000000000', parentPath: '/tmp', folderName: 'new-folder' },
      authToken,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('Controller not found');
  });

  it('should reject createFolder for offline controller', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `mkdir-offline-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'mkdir-offline', version: '2.0.0' });
    const regData = await registered;
    client.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const res = await gqlRequest(
      CREATE_FOLDER,
      { controllerId: regData.controllerId, parentPath: '/tmp', folderName: 'new-folder' },
      authToken,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('Controller is offline');
  });

  it('should create a folder via WebSocket protocol and return FolderEntry', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `mkdir-ok-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'mkdir-ok', version: '2.0.0' });
    const regData = await registered;

    const fsMkdir = waitForEvent<{
      requestId: string;
      parentPath: string;
      folderName: string;
    }>(client, 'fs:mkdir', 10000);

    const responsePromise = gqlRequest(
      CREATE_FOLDER,
      { controllerId: regData.controllerId, parentPath: '/home/user', folderName: 'my-project' },
      authToken,
    );

    const mkdirData = await fsMkdir;
    expect(mkdirData.parentPath).toBe('/home/user');
    expect(mkdirData.folderName).toBe('my-project');

    client.emit('fs:mkdir:result', {
      requestId: mkdirData.requestId,
      success: true,
      name: 'my-project',
      path: '/home/user/my-project',
      isDirectory: true,
    });

    const res = await responsePromise;
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.createFolder.name).toBe('my-project');
    expect(body.data.createFolder.path).toBe('/home/user/my-project');
    expect(body.data.createFolder.isDirectory).toBe(true);

    client.disconnect();
  }, 30000);

  it('should return GraphQL error when folder creation fails via WebSocket', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `mkdir-fail-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: keyBody.data.createControllerKey.rawKey, hostname: 'mkdir-fail', version: '2.0.0' });
    const regData = await registered;

    const fsMkdir = waitForEvent<{
      requestId: string;
    }>(client, 'fs:mkdir', 10000);

    const responsePromise = gqlRequest(
      CREATE_FOLDER,
      { controllerId: regData.controllerId, parentPath: '/home/user', folderName: 'existing-dir' },
      authToken,
    );

    const mkdirData = await fsMkdir;

    client.emit('fs:mkdir:result', {
      requestId: mkdirData.requestId,
      success: false,
      error: 'EEXIST: file already exists',
    });

    const res = await responsePromise;
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('EEXIST: file already exists');

    client.disconnect();
  }, 30000);
});
