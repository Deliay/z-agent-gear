import { describe, it, expect } from 'vitest';
import {
  buildModelProvision,
  flattenContextLengths,
  flattenModelIds,
  projectProvision,
  type ProvisionModelInput,
  type ProvisionProviderInput,
} from './model-provision.js';

function model(
  name: string,
  overrides: Partial<ProvisionModelInput> = {},
): ProvisionModelInput {
  return { name, isEnabled: true, scope: 'user', providerId: 'p1', ...overrides };
}

function provider(
  id: string,
  overrides: Partial<ProvisionProviderInput> = {},
): ProvisionProviderInput {
  return { id, name: `Provider ${id}`, isEnabled: true, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('buildModelProvision', () => {
  it('T-MP1: global models go into the leading zag group with Agent Gear display name', () => {
    const provision = buildModelProvision(
      [
        model('kimi-k2', { scope: 'global', contextLength: 262144 }),
        model('gpt-5.1', { scope: 'global' }),
      ],
      [],
    );

    expect(provision.providers).toEqual([
      {
        vendorId: 'zag',
        displayName: 'Agent Gear',
        models: [{ id: 'kimi-k2', contextLength: 262144 }, { id: 'gpt-5.1' }],
      },
    ]);
  });

  it('T-MP1: still emits an empty zag group when there is no global model (D4)', () => {
    const provision = buildModelProvision([], []);

    expect(provision.providers).toEqual([
      { vendorId: 'zag', displayName: 'Agent Gear', models: [] },
    ]);
    expect(provision.providers[0].vendorId).toBe('zag');
  });

  it('T-MP2: groups user models by providerId with vendorId=providerId and displayName=provider.name', () => {
    const provision = buildModelProvision(
      [
        model('a-1', { providerId: 'p-a' }),
        model('b-1', { providerId: 'p-b' }),
        model('a-2', { providerId: 'p-a' }),
      ],
      [
        provider('p-a', { name: '我的 OpenAI' }),
        provider('p-b', { name: 'Anthropic 备用' }),
      ],
    );

    expect(provision.providers).toEqual([
      { vendorId: 'zag', displayName: 'Agent Gear', models: [] },
      {
        vendorId: 'p-a',
        displayName: '我的 OpenAI',
        models: [{ id: 'a-1' }, { id: 'a-2' }],
      },
      {
        vendorId: 'p-b',
        displayName: 'Anthropic 备用',
        models: [{ id: 'b-1' }],
      },
    ]);
  });

  it('T-MP2: orders groups by provider createdAt ascending, breaking ties by _id', () => {
    const provision = buildModelProvision(
      [
        model('late-1', { providerId: 'p-late' }),
        model('early-1', { providerId: 'p-early' }),
        model('tie-b', { providerId: 'p-b' }),
        model('tie-a', { providerId: 'p-a' }),
      ],
      [
        provider('p-late', { createdAt: '2026-03-01T00:00:00.000Z' }),
        provider('p-early', { createdAt: '2026-01-01T00:00:00.000Z' }),
        provider('p-b', { createdAt: '2026-02-01T00:00:00.000Z' }),
        provider('p-a', { createdAt: '2026-02-01T00:00:00.000Z' }),
      ],
    );

    expect(provision.providers.map((group) => group.vendorId)).toEqual([
      'zag',
      'p-early',
      'p-a',
      'p-b',
      'p-late',
    ]);
  });

  it('T-MP2: keeps the findAll order inside each group', () => {
    const provision = buildModelProvision(
      [
        model('first', { providerId: 'p1' }),
        model('second', { providerId: 'p1' }),
        model('third', { providerId: 'p1' }),
      ],
      [provider('p1')],
    );

    expect(provision.providers[1].models).toEqual([
      { id: 'first' },
      { id: 'second' },
      { id: 'third' },
    ]);
  });

  it('T-MP3: drops disabled models', () => {
    const provision = buildModelProvision(
      [
        model('enabled', { providerId: 'p1' }),
        model('disabled', { providerId: 'p1', isEnabled: false }),
        model('global-disabled', { scope: 'global', isEnabled: false }),
      ],
      [provider('p1')],
    );

    expect(flattenModelIds(provision)).toEqual(['enabled']);
  });

  it('T-MP3: drops user models whose provider is missing or disabled, but global models ignore provider state', () => {
    const provision = buildModelProvision(
      [
        model('orphan', { providerId: 'missing' }),
        model('from-disabled', { providerId: 'p-off' }),
        model('global-model', { scope: 'global', providerId: 'p-off' }),
      ],
      [provider('p-off', { isEnabled: false })],
    );

    expect(provision.providers).toEqual([
      {
        vendorId: 'zag',
        displayName: 'Agent Gear',
        models: [{ id: 'global-model' }],
      },
    ]);
  });

  it('T-MP4: global wins on duplicate names, user duplicate is dropped', () => {
    const provision = buildModelProvision(
      [
        model('shared', { providerId: 'p1', contextLength: 64000 }),
        model('shared', { scope: 'global', contextLength: 128000 }),
      ],
      [provider('p1')],
    );

    expect(provision.providers).toEqual([
      {
        vendorId: 'zag',
        displayName: 'Agent Gear',
        models: [{ id: 'shared', contextLength: 128000 }],
      },
    ]);
  });

  it('T-MP4: duplicate ids keep only the first occurrence (F2 fixture shape)', () => {
    const provision = buildModelProvision(
      [
        model('model-a', { providerId: 'p1', contextLength: 128000 }),
        model('model-a', { providerId: 'p1', contextLength: 64000 }),
        model('model-b', { providerId: 'p1', contextLength: null }),
      ],
      [provider('p1')],
    );

    expect(provision.providers[1].models).toEqual([
      { id: 'model-a', contextLength: 128000 },
      { id: 'model-b' },
    ]);
  });

  it('T-MP5: only positive integers are carried as contextLength', () => {
    const provision = buildModelProvision(
      [
        model('ok', { providerId: 'p1', contextLength: 128000 }),
        model('zero', { providerId: 'p1', contextLength: 0 }),
        model('negative', { providerId: 'p1', contextLength: -1 }),
        model('float', { providerId: 'p1', contextLength: 1.5 }),
        model('string', { providerId: 'p1', contextLength: '128000' }),
        model('nan', { providerId: 'p1', contextLength: Number.NaN }),
        model('null', { providerId: 'p1', contextLength: null }),
        model('undefined', { providerId: 'p1', contextLength: undefined }),
      ],
      [provider('p1')],
    );

    expect(provision.providers[1].models).toEqual([
      { id: 'ok', contextLength: 128000 },
      { id: 'zero' },
      { id: 'negative' },
      { id: 'float' },
      { id: 'string' },
      { id: 'nan' },
      { id: 'null' },
      { id: 'undefined' },
    ]);
  });

  it('trims names and skips empty ones', () => {
    const provision = buildModelProvision(
      [
        model('  padded  ', { providerId: 'p1' }),
        model('   ', { providerId: 'p1' }),
        model('', { providerId: 'p1' }),
      ],
      [provider('p1')],
    );

    expect(flattenModelIds(provision)).toEqual(['padded']);
  });
});

describe('projectProvision', () => {
  it('T-MP6: flattens model ids in group order and keeps only positive context lengths', () => {
    const provision = buildModelProvision(
      [
        model('global-a', { scope: 'global', contextLength: 262144 }),
        model('model-a', { providerId: 'p1', contextLength: 128000 }),
        model('model-b', { providerId: 'p1', contextLength: null }),
        model('model-c', { providerId: 'p2', contextLength: 32000 }),
      ],
      [
        provider('p1', { createdAt: '2026-01-02T00:00:00.000Z' }),
        provider('p2', { createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
    );

    expect(projectProvision(provision)).toEqual({
      modelIds: ['global-a', 'model-c', 'model-a', 'model-b'],
      modelContextLengths: {
        'global-a': 262144,
        'model-c': 32000,
        'model-a': 128000,
      },
    });
  });

  it('T-MP6: matches the legacy creation snapshot byte for byte (F2 fixture)', () => {
    const provision = buildModelProvision(
      [
        model('model-a', { providerId: 'provider-1', contextLength: 128000 }),
        model('model-a', { providerId: 'provider-1', contextLength: 64000 }),
        model('model-b', { providerId: 'provider-1', contextLength: null }),
        model('disabled', { providerId: 'provider-1', isEnabled: false, contextLength: 1000 }),
      ],
      [provider('provider-1')],
    );

    const legacy = projectProvision(provision);
    expect(JSON.stringify(legacy.modelIds)).toBe('["model-a","model-b"]');
    expect(JSON.stringify(legacy.modelContextLengths)).toBe('{"model-a":128000}');
  });

  it('T-MP6: dedupes ids across groups and lets the first group win', () => {
    const provision = {
      providers: [
        { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'x', contextLength: 1000 }] },
        { vendorId: 'p1', displayName: 'P1', models: [{ id: 'x', contextLength: 2000 }, { id: 'y' }] },
      ],
    };

    expect(flattenModelIds(provision)).toEqual(['x', 'y']);
    expect(flattenContextLengths(provision)).toEqual({ x: 1000 });
    expect(projectProvision(provision)).toEqual({
      modelIds: ['x', 'y'],
      modelContextLengths: { x: 1000 },
    });
  });
});
