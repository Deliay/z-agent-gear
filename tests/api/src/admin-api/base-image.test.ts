import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';

const BASE_IMAGES = `
  query BaseImages {
    baseImages { id name description dockerfile createdAt updatedAt }
  }
`;

const BASE_IMAGE = `
  query BaseImage($id: ID!) { baseImage(id: $id) { id name description dockerfile } }
`;

const CREATE = `
  mutation CreateBaseImage($input: BaseImageInput!) {
    createBaseImage(input: $input) { id name description dockerfile createdAt updatedAt }
  }
`;

const UPDATE = `
  mutation UpdateBaseImage($id: ID!, $input: BaseImageInput!) {
    updateBaseImage(id: $id, input: $input) { id name description dockerfile }
  }
`;

const DELETE = `mutation($id: ID!) { deleteBaseImage(id: $id) }`;

const DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nRUN echo hello\n';

describe('Admin Base Image API', () => {
  let token = '';

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  it('should reject baseImages query without auth', async () => {
    const body = await adminGql(BASE_IMAGES);
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toBe('Not authenticated');
  });

  it('should reject create without auth', async () => {
    const body = await adminGql(CREATE, { input: { name: 'x', description: null, dockerfile: 'FROM a' } });
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toBe('Not authenticated');
  });

  it('should CRUD a base image preserving the Dockerfile verbatim (T-B1)', async () => {
    const name = `image-${Date.now()}`;
    const created = await adminGql<{ createBaseImage: { id: string; dockerfile: string } }>(CREATE, {
      input: { name, description: 'test image', dockerfile: DOCKERFILE },
    }, token);
    expect(created.errors).toBeUndefined();
    const id = created.data!.createBaseImage.id;
    expect(created.data!.createBaseImage.dockerfile).toBe(DOCKERFILE);

    const fetched = await adminGql<{ baseImage: { id: string; name: string } }>(BASE_IMAGE, { id }, token);
    expect(fetched.data!.baseImage.name).toBe(name);

    const updated = await adminGql<{ updateBaseImage: { description: string; dockerfile: string } }>(UPDATE, {
      id,
      input: { name: `${name}-v2`, description: 'updated', dockerfile: `${DOCKERFILE}# tail\n` },
    }, token);
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.updateBaseImage.description).toBe('updated');

    const list = await adminGql<{ baseImages: Array<{ id: string }> }>(BASE_IMAGES, undefined, token);
    expect(list.data!.baseImages.some((b) => b.id === id)).toBe(true);

    const deleted = await adminGql<{ deleteBaseImage: boolean }>(DELETE, { id }, token);
    expect(deleted.data!.deleteBaseImage).toBe(true);
  });

  it('should reject duplicate base image name (T-B2)', async () => {
    const name = `dup-image-${Date.now()}`;
    const first = await adminGql<{ createBaseImage: { id: string } }>(CREATE, {
      input: { name, description: null, dockerfile: DOCKERFILE },
    }, token);
    expect(first.errors).toBeUndefined();

    const second = await adminGql(CREATE, {
      input: { name, description: null, dockerfile: DOCKERFILE },
    }, token);
    expect(second.errors).toBeDefined();
    expect(second.errors![0].message).toBe('Base image name already exists');

    await adminGql(DELETE, { id: first.data!.createBaseImage.id }, token);
  });
});
