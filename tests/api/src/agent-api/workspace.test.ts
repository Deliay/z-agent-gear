import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import { startMockServer, type MockServer } from '../mock-server.js';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

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

async function newUserToken(): Promise<string> {
  const { token } = await createFrontUser();
  return token;
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
    authToken = await newUserToken();
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
      authToken = await newUserToken();
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
      authToken = await newUserToken();
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
    let createdWorkspace: { id: string; controllerId: string };

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
      authToken = await newUserToken();
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
      authToken = await newUserToken();
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

// ---------------------------------------------------------------------------
// 多租户二期：工作区上下文 / 工作区 CRUD / 共享读 / Commit 继承 / 租户成员
// （计划 Phase 10 T-WS-API、T-TM-API；契约 contracts/workspace.graphql）
// ---------------------------------------------------------------------------

const AGENT_API_BASE = API_URL.replace(/\/graphql\/?$/, '');

const MY_WORKSPACES = `
  query MyWorkspaces {
    myWorkspaces {
      id name type memberCount myRole readOnly
      tenant { id name type memberCount }
      createdAt
    }
  }
`;

const MY_TENANTS = `
  query MyTenants {
    myTenants { role tenant { id name type memberCount } }
  }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) {
      id name type memberCount myRole readOnly
      tenant { id type }
    }
  }
`;

const RENAME_TENANT_WORKSPACE = `
  mutation RenameTenantWorkspace($id: ID!, $name: String!) {
    renameTenantWorkspace(id: $id, name: $name) { id name type }
  }
`;

const DELETE_TENANT_WORKSPACE = `
  mutation DeleteTenantWorkspace($id: ID!) { deleteTenantWorkspace(id: $id) }
`;

const ADD_TENANT_WORKSPACE_MEMBER = `
  mutation AddTenantWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) {
      id memberCount
    }
  }
`;

const WORKSPACE_MEMBERS = `
  query WorkspaceMembers($workspaceId: ID!) {
    workspaceMembers(workspaceId: $workspaceId) { id name username role }
  }
`;

const SEARCH_ACCOUNTS = `
  query SearchAccounts($keyword: String!) {
    searchAccounts(keyword: $keyword) { username name userId }
  }
`;

const ADD_TENANT_MEMBER = `
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    addTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id name username role
    }
  }
`;

const REMOVE_TENANT_MEMBER = `
  mutation RemoveTenantMember($tenantId: ID!, $userId: ID!) {
    removeTenantMember(tenantId: $tenantId, userId: $userId)
  }
`;

const CHANGE_TENANT_MEMBER_ROLE = `
  mutation ChangeTenantMemberRole($tenantId: ID!, $userId: ID!, $role: TenantRole!) {
    changeTenantMemberRole(tenantId: $tenantId, userId: $userId, role: $role) {
      id role
    }
  }
`;

const PROVIDERS = `
  query Providers {
    providers { id name scope workspaceId }
  }
`;

const MODELS = `
  query Models {
    models { id name scope workspaceId providerId }
  }
`;

const CREATE_PROVIDER = `
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) { id name scope workspaceId }
  }
`;

const DELETE_PROVIDER = `mutation DeleteProvider($id: ID!) { deleteProvider(id: $id) }`;

const COMMIT_SETTINGS = `
  query CommitSettings {
    commitSettings {
      committerMode committerType customName customEmail source readOnly
    }
  }
`;

const UPDATE_COMMIT_SETTINGS = `
  mutation UpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) {
      committerMode committerType customName customEmail source readOnly
    }
  }
`;

describe('多租户二期：工作区上下文与权限（T-WS-API）', () => {
  let admin: FrontUser;
  let developer: FrontUser;
  let outsider: FrontUser;
  let teamId = '';
  let teamName = '';
  let teamGlobalId = '';
  let normalWorkspaceId = '';
  let globalProviderId = '';
  let mockServer: MockServer;

  async function internalJson(
    path: string,
    method: 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const token = process.env.INTERNAL_API_TOKEN;
    if (!token) throw new Error('T-WS-API requires INTERNAL_API_TOKEN');
    const res = await fetch(`${AGENT_API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 保留原始文本便于排查
    }
    return { status: res.status, body: parsed };
  }

  async function gqlCtx(
    query: string,
    variables: Record<string, unknown> | undefined,
    token: string,
    workspaceId?: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (workspaceId) headers['x-workspace-id'] = workspaceId;
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: any; errors?: Array<{ message: string }> };
  }

  async function createTeamTenant(name: string): Promise<{ tenantId: string; globalWorkspaceId: string }> {
    const res = await internalJson('/internal/tenants', 'POST', { name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return {
      tenantId: res.body.tenant.id,
      globalWorkspaceId: res.body.globalWorkspace.id,
    };
  }

  async function addInternalMember(
    tenantId: string,
    username: string,
    role: 'admin' | 'developer',
  ): Promise<void> {
    const res = await internalJson(`/internal/tenants/${tenantId}/members`, 'POST', {
      username,
      role,
    });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  }

  beforeAll(async () => {
    admin = await createFrontUser();
    developer = await createFrontUser();
    outsider = await createFrontUser();
    mockServer = await startMockServer(['ws-shared-model']);

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    teamName = `mt2-${suffix}`.slice(0, 60);
    const team = await createTeamTenant(teamName);
    teamId = team.tenantId;
    teamGlobalId = team.globalWorkspaceId;
    await addInternalMember(teamId, admin.username, 'admin');
    await addInternalMember(teamId, developer.username, 'developer');

    // team admin 在团队全局工作区创建普通工作区，并把 developer 加入
    const created = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: `normal-${suffix}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    normalWorkspaceId = created.data.createTenantWorkspace.id;

    const joined = await gqlCtx(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();

    // 团队全局工作区中的共享供应商/模型（普通工作区应可读）
    const provider = await gqlCtx(
      CREATE_PROVIDER,
      {
        input: {
          name: `global-provider-${suffix}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mockServer.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-ws-api-test',
        },
      },
      admin.token,
      teamGlobalId,
    );
    expect(provider.errors, JSON.stringify(provider.errors)).toBeUndefined();
    globalProviderId = provider.data.createProvider.id;
  }, 60_000);

  afterAll(async () => {
    await mockServer?.close();
  });

  it('T-WS-API1: 缺省上下文回退个人全局工作区（与一期一致）；header 指向本租户全局可用', async () => {
    const workspaces = await gqlCtx(MY_WORKSPACES, undefined, outsider.token);
    expect(workspaces.errors).toBeUndefined();
    expect(workspaces.data.myWorkspaces).toHaveLength(1);
    const personalGlobal = workspaces.data.myWorkspaces[0];
    expect(personalGlobal.type).toBe('global');
    expect(personalGlobal.tenant).toMatchObject({ id: outsider.tenantId, type: 'personal' });
    expect(personalGlobal.myRole).toBe('admin');
    expect(personalGlobal.readOnly).toBe(false);

    // 无头请求沿用一期行为：共享资源查询可用（不因缺工作区上下文报错）
    const providers = await gqlCtx(PROVIDERS, undefined, outsider.token);
    expect(providers.errors).toBeUndefined();
    expect(Array.isArray(providers.data.providers)).toBe(true);
    const models = await gqlCtx(MODELS, undefined, outsider.token);
    expect(models.errors).toBeUndefined();
    expect(Array.isArray(models.data.models)).toBe(true);

    // 显式发送自己的个人全局工作区 id：等价上下文
    const explicit = await gqlCtx(MODELS, undefined, outsider.token, personalGlobal.id);
    expect(explicit.errors).toBeUndefined();
  });

  it('T-WS-API2: 非法 / 不可达 x-workspace-id 一律 workspace not found（不泄露存在性）', async () => {
    const invalid = await gqlCtx(MODELS, undefined, outsider.token, '000000000000000000000000');
    expect(invalid.errors?.[0]?.message).toBe('workspace not found');

    const notMemberGlobal = await gqlCtx(MODELS, undefined, outsider.token, teamGlobalId);
    expect(notMemberGlobal.errors?.[0]?.message).toBe('workspace not found');

    const notMemberNormal = await gqlCtx(MODELS, undefined, outsider.token, normalWorkspaceId);
    expect(notMemberNormal.errors?.[0]?.message).toBe('workspace not found');
  });

  it('T-WS-API3: 工作区 CRUD —— developer 拒绝、重名、改名、global 不可变、空/非空删除', async () => {
    const forbidden = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: 'dev-workspace' },
      developer.token,
      teamGlobalId,
    );
    expect(forbidden.errors?.[0]?.message).toBe('not a tenant admin');

    const created = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: `renamed-${Date.now().toString(36)}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors).toBeUndefined();
    const workspaceId = created.data.createTenantWorkspace.id;
    expect(created.data.createTenantWorkspace).toMatchObject({
      type: 'normal',
      myRole: 'admin',
      readOnly: false,
      memberCount: 0,
    });

    const duplicate = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: created.data.createTenantWorkspace.name },
      admin.token,
      teamGlobalId,
    );
    expect(duplicate.errors?.[0]?.message).toBe('workspace name already exists');

    const renamed = await gqlCtx(
      RENAME_TENANT_WORKSPACE,
      { id: workspaceId, name: `renamed-ok-${Date.now().toString(36)}` },
      admin.token,
      teamGlobalId,
    );
    expect(renamed.errors).toBeUndefined();
    expect(renamed.data.renameTenantWorkspace.name).toContain('renamed-ok-');

    const globalRename = await gqlCtx(
      RENAME_TENANT_WORKSPACE,
      { id: teamGlobalId, name: 'renamed-global' },
      admin.token,
      teamGlobalId,
    );
    expect(globalRename.errors?.[0]?.message).toBe('global workspace is immutable');

    const globalDelete = await gqlCtx(DELETE_TENANT_WORKSPACE, { id: teamGlobalId }, admin.token, teamGlobalId);
    expect(globalDelete.errors?.[0]?.message).toBe('global workspace is immutable');

    const globalMember = await gqlCtx(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: teamGlobalId, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(globalMember.errors?.[0]?.message).toBe('global workspace is immutable');

    const outsiderMember = await gqlCtx(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: workspaceId, userId: outsider.userId },
      admin.token,
      teamGlobalId,
    );
    expect(outsiderMember.errors?.[0]?.message).toBe('user is not a tenant member');

    const deleted = await gqlCtx(DELETE_TENANT_WORKSPACE, { id: workspaceId }, admin.token, teamGlobalId);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deleteTenantWorkspace).toBe(true);

    const after = await gqlCtx(MY_WORKSPACES, undefined, admin.token, teamGlobalId);
    expect(after.data.myWorkspaces.some((workspace: { id: string }) => workspace.id === workspaceId)).toBe(false);

    // 非空删除保护：先写入本工作区 commit 设置（user_commit_settings 计入 11 集合）
    const nonEmpty = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: `non-empty-${Date.now().toString(36)}` },
      admin.token,
      teamGlobalId,
    );
    const nonEmptyId = nonEmpty.data.createTenantWorkspace.id;
    const saved = await gqlCtx(
      UPDATE_COMMIT_SETTINGS,
      {
        input: {
          committerMode: 'HUMAN_ONLY',
          committerType: 'CUSTOM',
          customName: 'Non Empty',
          customEmail: 'non-empty@example.com',
        },
      },
      admin.token,
      nonEmptyId,
    );
    expect(saved.errors).toBeUndefined();
    const blocked = await gqlCtx(DELETE_TENANT_WORKSPACE, { id: nonEmptyId }, admin.token, teamGlobalId);
    expect(blocked.errors?.[0]?.message).toBe('workspace is not empty');
  });

  it('T-WS-API4: 普通工作区可读全局共享供应商/模型；普通上下文写全局被拒', async () => {
    const providers = await gqlCtx(PROVIDERS, undefined, developer.token, normalWorkspaceId);
    expect(providers.errors).toBeUndefined();
    const shared = providers.data.providers.find(
      (provider: { id: string }) => provider.id === globalProviderId,
    );
    expect(shared, '普通工作区应读到团队全局工作区的供应商').toBeDefined();
    expect(shared.workspaceId).toBe(teamGlobalId);
    expect(shared.scope).toBe('user');

    const models = await gqlCtx(MODELS, undefined, developer.token, normalWorkspaceId);
    expect(models.errors).toBeUndefined();
    const model = models.data.models.find(
      (row: { name: string }) => row.name === 'ws-shared-model',
    );
    expect(model, '普通工作区应读到全局共享模型').toBeDefined();
    expect(model.workspaceId).toBe(teamGlobalId);

    // 普通上下文删除全局工作区供应商：写口径仅当前工作区 → 不生效
    const deleted = await gqlCtx(DELETE_PROVIDER, { id: globalProviderId }, developer.token, normalWorkspaceId);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deleteProvider).toBe(false);

    // 全局上下文由 admin 删除后，普通工作区入口随即不可用
    const deletedByAdmin = await gqlCtx(DELETE_PROVIDER, { id: globalProviderId }, admin.token, teamGlobalId);
    expect(deletedByAdmin.errors).toBeUndefined();
    expect(deletedByAdmin.data.deleteProvider).toBe(true);
    const after = await gqlCtx(PROVIDERS, undefined, developer.token, normalWorkspaceId);
    expect(after.data.providers.some((provider: { id: string }) => provider.id === globalProviderId)).toBe(false);
  });

  it('T-WS-API5: Commit 三段继承矩阵（UNSET → GLOBAL → WORKSPACE）', async () => {
    const unset = await gqlCtx(COMMIT_SETTINGS, undefined, admin.token, normalWorkspaceId);
    expect(unset.errors).toBeUndefined();
    expect(unset.data.commitSettings).toMatchObject({ source: 'UNSET', committerMode: 'UNSET' });

    const setGlobal = await gqlCtx(
      UPDATE_COMMIT_SETTINGS,
      {
        input: {
          committerMode: 'HUMAN_ONLY',
          committerType: 'CUSTOM',
          customName: 'Global Committer',
          customEmail: 'global-committer@example.com',
        },
      },
      admin.token,
      teamGlobalId,
    );
    expect(setGlobal.errors).toBeUndefined();
    expect(setGlobal.data.updateCommitSettings).toMatchObject({
      source: 'WORKSPACE',
      customName: 'Global Committer',
    });

    const inherited = await gqlCtx(COMMIT_SETTINGS, undefined, admin.token, normalWorkspaceId);
    expect(inherited.errors).toBeUndefined();
    expect(inherited.data.commitSettings).toMatchObject({
      source: 'GLOBAL',
      customName: 'Global Committer',
      committerMode: 'HUMAN_ONLY',
    });

    const setOwn = await gqlCtx(
      UPDATE_COMMIT_SETTINGS,
      {
        input: {
          committerMode: 'HUMAN_ONLY',
          committerType: 'CUSTOM',
          customName: 'Workspace Committer',
          customEmail: 'workspace-committer@example.com',
        },
      },
      admin.token,
      normalWorkspaceId,
    );
    expect(setOwn.errors).toBeUndefined();
    expect(setOwn.data.updateCommitSettings.source).toBe('WORKSPACE');

    const own = await gqlCtx(COMMIT_SETTINGS, undefined, admin.token, normalWorkspaceId);
    expect(own.data.commitSettings).toMatchObject({
      source: 'WORKSPACE',
      customName: 'Workspace Committer',
    });
  });

  it('T-WS-API6: developer 在团队全局工作区只读（global workspace is read-only）', async () => {
    // 共享资源写入在 workspace-scope 插件层统一拦截（provider 的 resolver 原样透出白名单文案）
    const write = await gqlCtx(
      CREATE_PROVIDER,
      {
        input: {
          name: `dev-global-${Date.now().toString(36)}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mockServer.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-dev-readonly',
        },
      },
      developer.token,
      teamGlobalId,
    );
    expect(write.errors?.[0]?.message).toBe('global workspace is read-only');

    const create = await gqlCtx(CREATE_TENANT_WORKSPACE, { name: 'nope' }, developer.token, teamGlobalId);
    expect(create.errors?.[0]?.message).toBe('not a tenant admin');
  });

  it('T-WS-API7: personal 租户拒绝创建租户工作区', async () => {
    const own = await gqlCtx(MY_WORKSPACES, undefined, outsider.token);
    const personalGlobalId = own.data.myWorkspaces[0].id;
    const res = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: 'personal-workspace' },
      outsider.token,
      personalGlobalId,
    );
    expect(res.errors?.[0]?.message).toBe('personal tenant cannot create workspaces');
  });

  it('T-WS-API8: 租户成员管理 —— search/add(role)/changeRole/remove 失效', async () => {
    const search = await gqlCtx(SEARCH_ACCOUNTS, { keyword: developer.username }, admin.token, teamGlobalId);
    expect(search.errors).toBeUndefined();
    const hit = search.data.searchAccounts.find(
      (account: { username: string }) => account.username === developer.username,
    );
    expect(hit).toEqual({
      username: developer.username,
      name: developer.name,
      userId: developer.userId,
    });

    const developerSearch = await gqlCtx(SEARCH_ACCOUNTS, { keyword: 'x' }, developer.token);
    expect(developerSearch.errors?.[0]?.message).toBe('not a tenant admin');

    const temp = await createFrontUser();
    const added = await gqlCtx(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: temp.username, role: 'developer' },
      admin.token,
    );
    expect(added.errors).toBeUndefined();
    expect(added.data.addTenantMember).toMatchObject({
      id: temp.userId,
      username: temp.username,
      role: 'developer',
    });

    // 重复添加幂等，不覆盖既有角色
    const again = await gqlCtx(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: temp.username, role: 'admin' },
      admin.token,
    );
    expect(again.errors).toBeUndefined();
    expect(again.data.addTenantMember.role).toBe('developer');

    const promoted = await gqlCtx(
      CHANGE_TENANT_MEMBER_ROLE,
      { tenantId: teamId, userId: temp.userId, role: 'admin' },
      admin.token,
    );
    expect(promoted.errors).toBeUndefined();
    expect(promoted.data.changeTenantMemberRole.role).toBe('admin');

    // 加入普通工作区后移出租户：立即失去访问，workspacemembers 级联清理
    const joined = await gqlCtx(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: temp.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors).toBeUndefined();

    const removed = await gqlCtx(
      REMOVE_TENANT_MEMBER,
      { tenantId: teamId, userId: temp.userId },
      admin.token,
    );
    expect(removed.errors).toBeUndefined();
    expect(removed.data.removeTenantMember).toBe(true);

    const tempWorkspaces = await gqlCtx(MY_WORKSPACES, undefined, temp.token);
    expect(
      tempWorkspaces.data.myWorkspaces.some(
        (workspace: { tenant: { id: string } }) => workspace.tenant.id === teamId,
      ),
    ).toBe(false);

    const tempHeader = await gqlCtx(MODELS, undefined, temp.token, teamGlobalId);
    expect(tempHeader.errors?.[0]?.message).toBe('workspace not found');

    const members = await gqlCtx(WORKSPACE_MEMBERS, { workspaceId: normalWorkspaceId }, admin.token, normalWorkspaceId);
    expect(members.errors).toBeUndefined();
    expect(members.data.workspaceMembers.some((row: { id: string }) => row.id === temp.userId)).toBe(false);

    // 资源/工作区保留：admin 仍可访问该普通工作区
    const retained = await gqlCtx(MY_WORKSPACES, undefined, admin.token, teamGlobalId);
    expect(retained.data.myWorkspaces.some((workspace: { id: string }) => workspace.id === normalWorkspaceId)).toBe(true);
  });

  it('T-WS-API9: last-admin 移除/降级拒绝；personal 租户写操作一律拒绝', async () => {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const solo = await createTeamTenant(`mt2-solo-${suffix}`.slice(0, 60));
    await addInternalMember(solo.tenantId, admin.username, 'admin');

    const demote = await gqlCtx(
      CHANGE_TENANT_MEMBER_ROLE,
      { tenantId: solo.tenantId, userId: admin.userId, role: 'developer' },
      admin.token,
    );
    expect(demote.errors?.[0]?.message).toBe('last admin cannot be demoted');

    const remove = await gqlCtx(
      REMOVE_TENANT_MEMBER,
      { tenantId: solo.tenantId, userId: admin.userId },
      admin.token,
    );
    expect(remove.errors?.[0]?.message).toBe('last admin cannot be removed');

    const personal = await gqlCtx(MY_TENANTS, undefined, outsider.token);
    const personalTenantId = personal.data.myTenants[0].tenant.id;
    for (const result of [
      await gqlCtx(
        ADD_TENANT_MEMBER,
        { tenantId: personalTenantId, username: developer.username, role: 'developer' },
        admin.token,
      ),
      await gqlCtx(
        REMOVE_TENANT_MEMBER,
        { tenantId: personalTenantId, userId: outsider.userId },
        admin.token,
      ),
      await gqlCtx(
        CHANGE_TENANT_MEMBER_ROLE,
        { tenantId: personalTenantId, userId: outsider.userId, role: 'admin' },
        admin.token,
      ),
    ]) {
      expect(result.errors?.[0]?.message).toBe('personal tenant is immutable');
    }
  });
});

// ---------------------------------------------------------------------------
// 多租户二期：8 个资源集合的工作区隔离（T-WS-ISO）
//
// 覆盖：sessions / controllers / controllerkeys / cloudhosts / githubaccounts /
//       configuredworkflows / workflowinstances / workflowtemplates。
// 每个集合断言三件事：同工作区成员（developer）可看到（并在可控处操作）他人创建的资源、
// 非成员（其它租户）不可见、admin 切换到目标工作区后可见；workflowTemplates 额外断言
// 「内置模板全工作区可用且 resourceWorkspaceId=null」。
//
// 夹具说明：
// - controllers / controllerkeys / sessions 走真实 GraphQL + controller-api 注册（fake socket 在线）；
// - configuredWorkflows / workflowInstances 走真实模板 → 配置 → 实例化链路；
// - **cloudhosts 与 githubaccounts 没有前台创建 API**（云电脑需 HARNESS_ENABLED，GitHub 绑定
//   需真实 GitHub App OAuth），本套件用 MONGODB_URI 直插夹具，缺参时两条用例显式 skip 并在用例名标注。
//
// 需要 agent-api + controller-api 就绪、INTERNAL_API_TOKEN（造 team 租户/成员）；
// 其余依赖 MONGODB_URI 的用例见各自 skipIf。
// ---------------------------------------------------------------------------

const ISO_SESSIONS = `
  query IsoSessions {
    sessions { id status acpServerType controllerId }
  }
`;
const ISO_SESSION = `query IsoSession($id: ID!) { session(id: $id) { id status controllerId } }`;
const ISO_CONTROLLERS = `
  query IsoControllers { controllers { id name type status } }
`;
const ISO_CONTROLLER = `query IsoController($id: ID!) { controller(id: $id) { id name } }`;
const ISO_CONTROLLER_KEYS = `
  query IsoControllerKeys { controllerKeys { id name } }
`;
const ISO_CLOUD_HOSTS = `
  query IsoCloudHosts { myCloudHosts { id name status workspaceId controllerId } }
`;
const ISO_CLOUD_HOST = `query IsoCloudHost($id: ID!) { cloudHost(id: $id) { id name workspaceId } }`;
const ISO_GITHUB_ACCOUNTS = `
  query IsoGithubAccounts { githubAccounts { id githubLogin workspaceId } }
`;
const ISO_CONFIGURED_WORKFLOWS = `
  query IsoConfiguredWorkflows {
    configuredWorkflows { id name controllerId resourceWorkspaceId }
  }
`;
const ISO_WORKFLOW_TEMPLATES = `
  query IsoWorkflowTemplates {
    workflowTemplates { id name isBuiltin resourceWorkspaceId }
  }
`;
const ISO_WORKFLOW_INSTANCES = `
  query IsoWorkflowInstances {
    workflowInstances { id name resourceWorkspaceId workspaceId }
  }
`;
const ISO_REFRESH_CAPABILITIES = `
  mutation IsoRefreshCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available version }
  }
`;
const ISO_RENAME_CONTROLLER_KEY = `
  mutation IsoRenameControllerKey($input: RenameInput!) {
    renameControllerKey(input: $input) { id name }
  }
`;
const ISO_RENAME_CONTROLLER = `
  mutation IsoRenameController($input: RenameInput!) {
    renameController(input: $input) { id name }
  }
`;
const ISO_CREATE_WORKFLOW_TEMPLATE = `
  mutation IsoCreateTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) {
      id name isBuiltin version resourceWorkspaceId
    }
  }
`;
const ISO_CONFIGURE_WORKFLOW = `
  mutation IsoConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name controllerId sourceTemplateId resourceWorkspaceId
    }
  }
`;
const ISO_INSTANTIATE_WORKFLOW = `
  mutation IsoInstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name controllerId workspaceId resourceWorkspaceId
      nodes { id nodeKey type name status }
    }
  }
`;

/** 单 HUMAN 节点的最小模板（不触发 acp:start / Worktree，专注工作区归属） */
const ISO_TEMPLATE_NODE = {
  nodeKey: 'approve',
  type: 'HUMAN',
  name: '审核',
  stage: '阶段一',
  dependsOn: [] as string[],
  requiresWorktree: false,
};

describe('多租户二期：8 个资源集合的工作区隔离（T-WS-ISO）', () => {
  const HAS_MONGO = Boolean(process.env.MONGODB_URI);

  let admin: FrontUser;
  let developer: FrontUser;
  let outsider: FrontUser;
  let teamId = '';
  let teamGlobalId = '';
  let normalId = '';
  let controllerId = '';
  let controllerName = '';
  let unboundKeyId = '';
  let projectWorkspaceId = '';
  let sessionId = '';
  let templateId = '';
  let configuredId = '';
  let instanceId = '';
  let cloudHostId = '';
  let githubAccountId = '';
  let controllerSocket: ClientSocket | null = null;
  let cleanupDb: (() => Promise<void>) | null = null;

  async function gql(
    query: string,
    variables: Record<string, unknown> | undefined,
    token: string,
    workspaceId?: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (workspaceId) headers['x-workspace-id'] = workspaceId;
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: any; errors?: Array<{ message: string }> };
  }

  async function internalJson(path: string, method: 'POST', body: unknown) {
    const token = process.env.INTERNAL_API_TOKEN;
    if (!token) throw new Error('T-WS-ISO requires INTERNAL_API_TOKEN');
    const res = await fetch(`${AGENT_API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 保留原文便于排查
    }
    return { status: res.status, body: parsed };
  }

  async function mongoDb(): Promise<mongoose.mongo.Db | null> {
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    return mongoose.connection.db ?? null;
  }

  /** 创建 key 并注册 fake controller（保持在线，用于 acp:check 能力探测）。 */
  async function registerController(
    token: string,
    workspaceId: string,
    name: string,
  ): Promise<{ controllerId: string; socket: ClientSocket }> {
    const keyRes = await gql(
      CREATE_KEY,
      { input: { name, type: 'local' } },
      token,
      workspaceId,
    );
    expect(keyRes.errors, JSON.stringify(keyRes.errors)).toBeUndefined();
    const rawKey = keyRes.data.createControllerKey.rawKey as string;

    const socket = createClient();
    socket.on('acp:check', (data: { requestId: string }) => {
      socket.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });
    const registered = waitForEvent<{ controllerId: string }>(socket, 'registered', 10000);
    socket.emit('register', { key: rawKey, hostname: `iso-host-${Date.now()}`, version: '2.0.0' });
    const reg = await registered;
    return { controllerId: reg.controllerId, socket };
  }

  beforeAll(async () => {
    admin = await createFrontUser();
    developer = await createFrontUser();
    outsider = await createFrontUser();

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const team = await internalJson('/internal/tenants', 'POST', {
      name: `iso2-${suffix}`.slice(0, 60),
    });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.tenant.id;
    teamGlobalId = team.body.globalWorkspace.id;

    for (const [username, role] of [
      [admin.username, 'admin'],
      [developer.username, 'developer'],
    ] as const) {
      const added = await internalJson(`/internal/tenants/${teamId}/members`, 'POST', { username, role });
      expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
    }

    // 团队普通工作区：admin 创建，developer 加入（admin 天然可管全部工作区）
    const created = await gql(
      CREATE_TENANT_WORKSPACE,
      { name: `iso-normal-${suffix}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    normalId = created.data.createTenantWorkspace.id;

    const joined = await gql(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalId, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();

    // 控制器 / key 均落在普通工作区上下文
    controllerName = `iso-ctrl-${suffix}`;
    const reg = await registerController(admin.token, normalId, controllerName);
    controllerId = reg.controllerId;
    controllerSocket = reg.socket;

    const unbound = await gql(
      CREATE_KEY,
      { input: { name: `iso-unbound-${suffix}`, type: 'local' } },
      admin.token,
      normalId,
    );
    expect(unbound.errors, JSON.stringify(unbound.errors)).toBeUndefined();
    unboundKeyId = unbound.data.createControllerKey.key.id;

    // 项目工作区（ControllerWorkspace）供会话/工作流实例使用
    const project = await gql(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/iso-${suffix}` } },
      admin.token,
      normalId,
    );
    expect(project.errors, JSON.stringify(project.errors)).toBeUndefined();
    projectWorkspaceId = project.data.createWorkspace.id;

    // 预热控制器能力缓存（fake controller 应答 acp:check），避免后续串行 12s 轮询
    const caps = await gql(ISO_REFRESH_CAPABILITIES, { controllerId }, admin.token, normalId);
    expect(caps.errors, JSON.stringify(caps.errors)).toBeUndefined();

    // sessions 夹具：admin 在普通工作区创建
    const session = await gql(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId: projectWorkspaceId } },
      admin.token,
      normalId,
    );
    expect(session.errors, JSON.stringify(session.errors)).toBeUndefined();
    sessionId = session.data.createSession.session.id;

    // workflowTemplates / configuredWorkflows 夹具：admin 在普通工作区创建
    const template = await gql(
      ISO_CREATE_WORKFLOW_TEMPLATE,
      { input: { name: `iso-tpl-${suffix}`, nodes: [ISO_TEMPLATE_NODE] } },
      admin.token,
      normalId,
    );
    expect(template.errors, JSON.stringify(template.errors)).toBeUndefined();
    templateId = template.data.createWorkflowTemplate.id;

    const configured = await gql(
      ISO_CONFIGURE_WORKFLOW,
      {
        templateId,
        input: {
          name: `iso-cfg-${suffix}`,
          controllerId,
          nodes: [{ ...ISO_TEMPLATE_NODE, agentConfig: null }],
        },
      },
      admin.token,
      normalId,
    );
    expect(configured.errors, JSON.stringify(configured.errors)).toBeUndefined();
    configuredId = configured.data.configureWorkflow.id;

    // workflowInstances 夹具：同一普通工作区实例化
    const instance = await gql(
      ISO_INSTANTIATE_WORKFLOW,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: configuredId,
          controllerId,
          workspaceId: projectWorkspaceId,
          name: `iso-inst-${suffix}`,
          nodes: [{ ...ISO_TEMPLATE_NODE, agentConfig: null }],
        },
      },
      admin.token,
      normalId,
    );
    expect(instance.errors, JSON.stringify(instance.errors)).toBeUndefined();
    instanceId = instance.data.instantiateWorkflow.id;

    if (HAS_MONGO) {
      const db = await mongoDb();
      if (db) {
        const hostObjectId = new mongoose.Types.ObjectId();
        const accountObjectId = new mongoose.Types.ObjectId();
        const now = new Date();
        await db.collection('cloudhosts').insertOne({
          _id: hostObjectId,
          userId: new mongoose.Types.ObjectId(admin.userId),
          tenantId: new mongoose.Types.ObjectId(teamId),
          resourceWorkspaceId: new mongoose.Types.ObjectId(normalId),
          workspaceId: new mongoose.Types.ObjectId(projectWorkspaceId),
          controllerId: new mongoose.Types.ObjectId(controllerId),
          keyId: new mongoose.Types.ObjectId(),
          name: 'iso-cloud-host',
          harnessTypes: ['OPENCODE'],
          status: 'RUNNING',
          containerId: hostObjectId.toString(),
          createDefaultSession: false,
          startedAt: now,
          readyAt: now,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await db.collection('githubaccounts').insertOne({
          _id: accountObjectId,
          userId: admin.userId,
          tenantId: teamId,
          workspaceId: normalId,
          githubUserId: 900000 + Math.floor(Math.random() * 100000),
          githubLogin: `iso-gh-${suffix}`,
          githubAvatarUrl: null,
          accessToken: 'gho_iso_test_token',
          tokenExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        });
        cloudHostId = hostObjectId.toString();
        githubAccountId = accountObjectId.toString();
        cleanupDb = async () => {
          await db.collection('cloudhosts').deleteOne({ _id: hostObjectId });
          await db.collection('githubaccounts').deleteOne({ _id: accountObjectId });
        };
      }
    }
  }, 120_000);

  afterAll(async () => {
    controllerSocket?.disconnect();
    await cleanupDb?.();
  });

  it('T-WS-ISO1 sessions：developer 可见/可读他人会话，非成员不可见，admin 切换后可见', async () => {
    const member = await gql(ISO_SESSIONS, undefined, developer.token, normalId);
    expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
    expect(member.data.sessions.some((row: { id: string }) => row.id === sessionId)).toBe(true);

    const detail = await gql(ISO_SESSION, { id: sessionId }, developer.token, normalId);
    expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
    expect(detail.data.session).toMatchObject({ id: sessionId, controllerId });

    const outsiderList = await gql(ISO_SESSIONS, undefined, outsider.token);
    expect(outsiderList.errors).toBeUndefined();
    expect(outsiderList.data.sessions.some((row: { id: string }) => row.id === sessionId)).toBe(false);
    const outsiderDetail = await gql(ISO_SESSION, { id: sessionId }, outsider.token);
    expect(outsiderDetail.data.session).toBeNull();

    const otherWorkspace = await gql(ISO_SESSIONS, undefined, admin.token, teamGlobalId);
    expect(otherWorkspace.data.sessions.some((row: { id: string }) => row.id === sessionId)).toBe(false);

    const adminList = await gql(ISO_SESSIONS, undefined, admin.token, normalId);
    expect(adminList.errors).toBeUndefined();
    expect(adminList.data.sessions.some((row: { id: string }) => row.id === sessionId)).toBe(true);
  });

  it('T-WS-ISO2 controllers/controllerkeys：developer 可见并可改名他人资源，非成员不可见', async () => {
    const member = await gql(ISO_CONTROLLERS, undefined, developer.token, normalId);
    expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
    expect(member.data.controllers.some((row: { id: string }) => row.id === controllerId)).toBe(true);

    // 操作：developer 重命名 admin 注册的控制器
    const renamed = await gql(
      ISO_RENAME_CONTROLLER,
      { input: { id: controllerId, name: `${controllerName}-dev-renamed` } },
      developer.token,
      normalId,
    );
    expect(renamed.errors, JSON.stringify(renamed.errors)).toBeUndefined();
    expect(renamed.data.renameController.name).toBe(`${controllerName}-dev-renamed`);

    const outsiderList = await gql(ISO_CONTROLLERS, undefined, outsider.token);
    expect(outsiderList.errors).toBeUndefined();
    expect(outsiderList.data.controllers.some((row: { id: string }) => row.id === controllerId)).toBe(false);
    const outsiderDetail = await gql(ISO_CONTROLLER, { id: controllerId }, outsider.token);
    expect(outsiderDetail.data.controller).toBeNull();

    const adminList = await gql(ISO_CONTROLLERS, undefined, admin.token, normalId);
    const adminRow = adminList.data.controllers.find((row: { id: string }) => row.id === controllerId);
    expect(adminRow?.name).toBe(`${controllerName}-dev-renamed`);

    // controllerKeys：未绑定 key 落在普通工作区
    const memberKeys = await gql(ISO_CONTROLLER_KEYS, undefined, developer.token, normalId);
    expect(memberKeys.errors, JSON.stringify(memberKeys.errors)).toBeUndefined();
    expect(memberKeys.data.controllerKeys.some((row: { id: string }) => row.id === unboundKeyId)).toBe(true);

    // 操作：developer 可重命名他人创建的未绑定 key
    const keyRenamed = await gql(
      ISO_RENAME_CONTROLLER_KEY,
      { input: { id: unboundKeyId, name: `iso-unbound-dev-${Date.now()}` } },
      developer.token,
      normalId,
    );
    expect(keyRenamed.errors, JSON.stringify(keyRenamed.errors)).toBeUndefined();
    expect(keyRenamed.data.renameControllerKey.name).toContain('iso-unbound-dev-');

    const outsiderKeys = await gql(ISO_CONTROLLER_KEYS, undefined, outsider.token);
    expect(outsiderKeys.errors).toBeUndefined();
    expect(outsiderKeys.data.controllerKeys.some((row: { id: string }) => row.id === unboundKeyId)).toBe(false);

    const adminKeys = await gql(ISO_CONTROLLER_KEYS, undefined, admin.token, normalId);
    expect(adminKeys.data.controllerKeys.some((row: { id: string }) => row.id === unboundKeyId)).toBe(true);
  });

  it.skipIf(!Boolean(process.env.MONGODB_URI))(
    'T-WS-ISO3 cloudhosts（MONGODB_URI 直插夹具）：成员可见、非成员不可见、CloudHost.workspaceId=租户工作区',
    async () => {
      expect(cloudHostId, 'cloudhosts 夹具需 MONGODB_URI').toBeTruthy();

      const member = await gql(ISO_CLOUD_HOSTS, undefined, developer.token, normalId);
      expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
      const memberHost = member.data.myCloudHosts.find((row: { id: string }) => row.id === cloudHostId);
      expect(memberHost).toMatchObject({ id: cloudHostId, workspaceId: normalId, controllerId });

      // 列表与详情均按工作区成员口径：成员可见/可读 admin 创建的主机
      const memberDetail = await gql(ISO_CLOUD_HOST, { id: cloudHostId }, developer.token, normalId);
      expect(memberDetail.errors, JSON.stringify(memberDetail.errors)).toBeUndefined();
      expect(memberDetail.data.cloudHost).toMatchObject({ id: cloudHostId, workspaceId: normalId });

      const adminDetail = await gql(ISO_CLOUD_HOST, { id: cloudHostId }, admin.token, normalId);
      expect(adminDetail.errors, JSON.stringify(adminDetail.errors)).toBeUndefined();
      expect(adminDetail.data.cloudHost).toMatchObject({ id: cloudHostId, workspaceId: normalId });

      // admin 可见/可读 developer 创建的成员主机
      const db = await mongoDb();
      const developerHostId = new mongoose.Types.ObjectId();
      await db!.collection('cloudhosts').insertOne({
        _id: developerHostId,
        userId: developer.userId,
        tenantId: teamId,
        resourceWorkspaceId: new mongoose.Types.ObjectId(normalId),
        controllerId: new mongoose.Types.ObjectId(),
        keyId: new mongoose.Types.ObjectId(),
        name: `dev-host-${Date.now()}`,
        harnessTypes: ['OPENCODE'],
        status: 'RUNNING',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      try {
        const adminOnMemberHost = await gql(ISO_CLOUD_HOST, { id: String(developerHostId) }, admin.token, normalId);
        expect(adminOnMemberHost.errors, JSON.stringify(adminOnMemberHost.errors)).toBeUndefined();
        expect(adminOnMemberHost.data.cloudHost?.id).toBe(String(developerHostId));
      } finally {
        await db!.collection('cloudhosts').deleteOne({ _id: developerHostId });
      }

      const outsiderList = await gql(ISO_CLOUD_HOSTS, undefined, outsider.token);
      expect(outsiderList.data.myCloudHosts.some((row: { id: string }) => row.id === cloudHostId)).toBe(false);
      const outsiderDetail = await gql(ISO_CLOUD_HOST, { id: cloudHostId }, outsider.token);
      expect(outsiderDetail.data.cloudHost).toBeNull();

      const adminList = await gql(ISO_CLOUD_HOSTS, undefined, admin.token, normalId);
      expect(adminList.data.myCloudHosts.some((row: { id: string }) => row.id === cloudHostId)).toBe(true);
    },
  );

  it.skipIf(!Boolean(process.env.MONGODB_URI))(
    'T-WS-ISO4 githubaccounts（MONGODB_URI 直插夹具）：共享读=本工作区∪全局，非成员不可见',
    async () => {
      expect(githubAccountId, 'githubaccounts 夹具需 MONGODB_URI').toBeTruthy();

      const member = await gql(ISO_GITHUB_ACCOUNTS, undefined, developer.token, normalId);
      expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
      const account = member.data.githubAccounts.find((row: { id: string }) => row.id === githubAccountId);
      expect(account).toMatchObject({ id: githubAccountId, workspaceId: normalId });

      const outsiderList = await gql(ISO_GITHUB_ACCOUNTS, undefined, outsider.token);
      expect(outsiderList.data.githubAccounts.some((row: { id: string }) => row.id === githubAccountId)).toBe(false);

      // 普通工作区行不进入团队全局上下文（共享读仅本工作区∪全局，不跨普通工作区）
      const globalList = await gql(ISO_GITHUB_ACCOUNTS, undefined, admin.token, teamGlobalId);
      expect(globalList.data.githubAccounts.some((row: { id: string }) => row.id === githubAccountId)).toBe(false);

      const adminList = await gql(ISO_GITHUB_ACCOUNTS, undefined, admin.token, normalId);
      expect(adminList.data.githubAccounts.some((row: { id: string }) => row.id === githubAccountId)).toBe(true);
    },
  );

  it('T-WS-ISO5 configuredWorkflows：成员可见他人配置，非成员不可见，resourceWorkspaceId=当前工作区', async () => {
    const member = await gql(ISO_CONFIGURED_WORKFLOWS, undefined, developer.token, normalId);
    expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
    const row = member.data.configuredWorkflows.find((item: { id: string }) => item.id === configuredId);
    expect(row, 'developer 应看到 admin 在普通工作区创建的已配置工作流').toBeDefined();
    expect(row.resourceWorkspaceId).toBe(normalId);
    expect(row.controllerId).toBe(controllerId);

    const detail = await gql(
      `query IsoConfiguredWorkflow($id: ID!) { configuredWorkflow(id: $id) { id name resourceWorkspaceId } }`,
      { id: configuredId },
      developer.token,
      normalId,
    );
    expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
    expect(detail.data.configuredWorkflow).toMatchObject({ id: configuredId, resourceWorkspaceId: normalId });

    const outsiderList = await gql(ISO_CONFIGURED_WORKFLOWS, undefined, outsider.token);
    expect(outsiderList.data.configuredWorkflows.some((item: { id: string }) => item.id === configuredId)).toBe(false);

    const otherWorkspace = await gql(ISO_CONFIGURED_WORKFLOWS, undefined, admin.token, teamGlobalId);
    expect(otherWorkspace.data.configuredWorkflows.some((item: { id: string }) => item.id === configuredId)).toBe(false);

    const adminList = await gql(ISO_CONFIGURED_WORKFLOWS, undefined, admin.token, normalId);
    const adminRow = adminList.data.configuredWorkflows.find((item: { id: string }) => item.id === configuredId);
    expect(adminRow?.resourceWorkspaceId).toBe(normalId);
  });

  it('T-WS-ISO6 workflowInstances：成员可见他人实例，非成员不可见，resourceWorkspaceId=当前工作区', async () => {
    const member = await gql(ISO_WORKFLOW_INSTANCES, undefined, developer.token, normalId);
    expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
    const row = member.data.workflowInstances.find((item: { id: string }) => item.id === instanceId);
    expect(row, 'developer 应看到 admin 在普通工作区实例化的工作流').toBeDefined();
    expect(row.resourceWorkspaceId).toBe(normalId);
    // 项目工作区语义（workspaceId）与租户工作区语义（resourceWorkspaceId）互不影响
    expect(row.workspaceId).toBe(projectWorkspaceId);

    const detail = await gql(
      `query IsoWorkflowInstance($id: ID!) { workflowInstance(id: $id) { id name resourceWorkspaceId workspaceId } }`,
      { id: instanceId },
      developer.token,
      normalId,
    );
    expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
    expect(detail.data.workflowInstance).toMatchObject({
      id: instanceId,
      resourceWorkspaceId: normalId,
      workspaceId: projectWorkspaceId,
    });

    const outsiderList = await gql(ISO_WORKFLOW_INSTANCES, undefined, outsider.token);
    expect(outsiderList.data.workflowInstances.some((item: { id: string }) => item.id === instanceId)).toBe(false);

    const otherWorkspace = await gql(ISO_WORKFLOW_INSTANCES, undefined, admin.token, teamGlobalId);
    expect(otherWorkspace.data.workflowInstances.some((item: { id: string }) => item.id === instanceId)).toBe(false);

    const adminList = await gql(ISO_WORKFLOW_INSTANCES, undefined, admin.token, normalId);
    expect(adminList.data.workflowInstances.some((item: { id: string }) => item.id === instanceId)).toBe(true);
  });

  it('T-WS-ISO7 workflowTemplates：内置模板全工作区可用且 resourceWorkspaceId=null，自定义模板归属工作区', async () => {
    // 自定义模板：普通工作区成员可见，非成员不可见
    const member = await gql(ISO_WORKFLOW_TEMPLATES, undefined, developer.token, normalId);
    expect(member.errors, JSON.stringify(member.errors)).toBeUndefined();
    const custom = member.data.workflowTemplates.find((item: { id: string }) => item.id === templateId);
    expect(custom, 'developer 应看到 admin 在普通工作区创建的自定义模板').toBeDefined();
    expect(custom.isBuiltin).toBe(false);
    expect(custom.resourceWorkspaceId).toBe(normalId);

    const outsiderTemplates = await gql(ISO_WORKFLOW_TEMPLATES, undefined, outsider.token);
    expect(outsiderTemplates.errors).toBeUndefined();
    expect(
      outsiderTemplates.data.workflowTemplates.some((item: { id: string }) => item.id === templateId),
    ).toBe(false);

    const otherWorkspace = await gql(ISO_WORKFLOW_TEMPLATES, undefined, admin.token, teamGlobalId);
    expect(otherWorkspace.data.workflowTemplates.some((item: { id: string }) => item.id === templateId)).toBe(false);

    const adminList = await gql(ISO_WORKFLOW_TEMPLATES, undefined, admin.token, normalId);
    expect(adminList.data.workflowTemplates.some((item: { id: string }) => item.id === templateId)).toBe(true);

    // 内置模板：跨工作区可用且 resourceWorkspaceId 恒 null（个人全局 / 团队全局 / 团队普通）
    const builtins = outsiderTemplates.data.workflowTemplates.filter(
      (item: { isBuiltin: boolean }) => item.isBuiltin,
    );
    expect(builtins.length, '内置模板应由 agent-api 启动 seed 写入').toBeGreaterThan(0);
    for (const item of builtins) {
      expect(item.resourceWorkspaceId).toBeNull();
    }
    const builtinId = builtins[0].id;
    for (const [token, workspaceId] of [
      [outsider.token, undefined],
      [admin.token, teamGlobalId],
      [developer.token, normalId],
    ] as const) {
      const list = await gql(ISO_WORKFLOW_TEMPLATES, undefined, token, workspaceId);
      expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
      const builtin = list.data.workflowTemplates.find((item: { id: string }) => item.id === builtinId);
      expect(builtin, '内置模板在任意工作区均应可用').toBeDefined();
      expect(builtin.resourceWorkspaceId).toBeNull();
    }
  });
});
