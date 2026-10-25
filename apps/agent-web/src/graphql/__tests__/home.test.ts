import { describe, it, expect } from 'vitest';
import { print } from 'graphql';
import { HOME_OVERVIEW } from '../home';
import {
  CLOUD_HOST_CAPABILITIES,
  CLOUD_HOST_STOP_IMPACT,
  GET_CONTROLLERS,
  MY_CLOUD_HOSTS,
} from '../queries';
import {
  CREATE_CLOUD_HOST,
  DELETE_CLOUD_HOST,
  RESPOND_HARNESS_LOGIN,
  STOP_CLOUD_HOST,
} from '../mutations';

describe('云电脑 GraphQL 文档（T-AW15）', () => {
  it('HOME_OVERVIEW.controllers 包含 cloudHost 及状态字段', () => {
    const document = print(HOME_OVERVIEW);

    expect(document).toContain('cloudHost');
    expect(document).toContain('fragment CloudHostFields on CloudHost');
    for (const field of [
      'status',
      'harnessTypes',
      'defaultSessionId',
      'activeSessionCount',
      'failureReason',
      'deletedAt',
    ]) {
      expect(document).toContain(field);
    }
  });

  it('GET_CONTROLLERS 包含 cloudHost', () => {
    expect(print(GET_CONTROLLERS)).toContain('cloudHost');
  });

  it('云电脑查询字段与契约一致', () => {
    expect(print(CLOUD_HOST_CAPABILITIES)).toContain('supportedHarnesses');
    expect(print(MY_CLOUD_HOSTS)).toContain('myCloudHosts');
    expect(print(CLOUD_HOST_STOP_IMPACT)).toContain('sessionsWillBeLost');
  });

  it('云电脑 mutation 变量与契约一致', () => {
    expect(print(CREATE_CLOUD_HOST)).toContain('createCloudHost(input: $input)');
    expect(print(STOP_CLOUD_HOST)).toContain('stopCloudHost(id: $id, force: $force)');
    expect(print(DELETE_CLOUD_HOST)).toContain('deleteCloudHost(id: $id)');
  });

  it('HOME_OVERVIEW.todos 携带 harnessLoginData 全部字段', () => {
    const document = print(HOME_OVERVIEW);

    expect(document).toContain('harnessLoginData');
    for (const field of ['requestId', 'controllerId', 'serverType', 'trigger', 'url', 'userCode', 'expiresAt']) {
      expect(document).toContain(field);
    }
  });

  it('RESPOND_HARNESS_LOGIN 与契约一致', () => {
    const document = print(RESPOND_HARNESS_LOGIN);

    expect(document).toContain('respondHarnessLogin(requestId: $requestId, action: $action)');
  });
});
