import { describe, expect, it } from 'vitest';
import { toMcpServerConfig } from './piSession';

describe('toMcpServerConfig', () => {
  it('maps a stdio server with its command, args and env', () => {
    expect(
      toMcpServerConfig({
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret' },
      })
    ).toEqual({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    });
  });

  it('maps a remote server (http or sse in the settings) to pi http with its headers', () => {
    expect(
      toMcpServerConfig({
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      })
    ).toEqual({
      name: 'context7',
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('leaves out optional fields the server does not have', () => {
    expect(toMcpServerConfig({ name: 'local', command: 'my-mcp' })).toEqual({
      name: 'local',
      type: 'stdio',
      command: 'my-mcp',
    });
    expect(toMcpServerConfig({ name: 'remote', url: 'http://127.0.0.1:3000/mcp' })).toEqual({
      name: 'remote',
      type: 'http',
      url: 'http://127.0.0.1:3000/mcp',
    });
  });
});
