import { describe, expect, it } from 'vitest';
import { maskSecrets } from './secretMask';

// 假密钥：形状照本机实际（context7 的 ctx7sk-、Tavily 的 tvly-），内容是编的
const CTX7 = 'ctx7sk-0f3a9c2e-6b1d-4e8f-a5c7-91d2e4b6f8a0';
const OPENAI = 'sk-proj-AbCdEfGhIjKlMnOpQrSt1234';
const TAVILY = 'tvly-dev-Zx9Yw8Vu7Ts6Rq5Po4';
const GITHUB = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
// 测试里不写字面的 `${…}`（Biome noTemplateCurlyInString）
const ref = (name: string) => `${'$'}{${name}}`;

describe('maskSecrets', () => {
  it('打码为前 3 + … + 后 2', () => {
    expect(maskSecrets(`cmd /c npx -y @upstash/context7-mcp --api-key ${CTX7}`)).toBe(
      'cmd /c npx -y @upstash/context7-mcp --api-key ctx…a0'
    );
  });

  it.each(['--api-key', '--token', '--key', '-k', '--password'])(
    '命令参数：%s 之后的一个参数',
    (flag) => {
      expect(maskSecrets(`npx -y some-mcp ${flag} abcdef123456 --verbose`)).toBe(
        `npx -y some-mcp ${flag} abc…56 --verbose`
      );
    }
  );

  it('开关后面紧跟另一个开关：不是它的值，照普通参数处理', () => {
    expect(maskSecrets('server --token --verbose-output')).toBe('server --token --verbose-output');
    expect(maskSecrets('server --token --api-key abcdef123456')).toBe(
      'server --token --api-key abc…56'
    );
  });

  it('命令参数的 key=value：开关写成 --flag=值，或键名含 key / token / secret / password / auth', () => {
    expect(maskSecrets('server --api-key=abcdef123456')).toBe('server --api-key=abc…56');
    expect(maskSecrets('server -k=abcdef123456')).toBe('server -k=abc…56');
    expect(
      maskSecrets(
        `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB} ghcr.io/github/github-mcp-server`
      )
    ).toBe(
      'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=ghp…23 ghcr.io/github/github-mcp-server'
    );
    expect(maskSecrets('env CLIENT_SECRET=s3cr3t-value-123 DB_PASSWORD=hunter22 node a.js')).toBe(
      'env CLIENT_SECRET=s3c…23 DB_PASSWORD=hun…22 node a.js'
    );
    expect(maskSecrets('server --auth=xyz123456789')).toBe('server --auth=xyz…89');
  });

  it('URL query：键名含 key / token / secret / password / auth 的值', () => {
    expect(maskSecrets(`https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY}`)).toBe(
      'https://mcp.tavily.com/mcp/?tavilyApiKey=tvl…o4'
    );
    expect(
      maskSecrets('https://a.example.com/sse?mode=fast&access_token=abcdef123456&page=2')
    ).toBe('https://a.example.com/sse?mode=fast&access_token=abc…56&page=2');
    expect(
      maskSecrets(
        'https://a.example.com/mcp?client_secret=abcdef123456&password=correcthorse&AUTH=xyz123456789'
      )
    ).toBe('https://a.example.com/mcp?client_secret=abc…56&password=cor…se&AUTH=xyz…89');
    // 命令参数里的 URL 同样处理
    expect(maskSecrets('npx -y mcp-remote https://a.example.com/sse?key=abcdef123456')).toBe(
      'npx -y mcp-remote https://a.example.com/sse?key=abc…56'
    );
  });

  it('长度 ≥ 20、形似 sk- / ctx7sk- 等前缀的 token：出现在哪都打码', () => {
    expect(maskSecrets(`node server.js ${OPENAI}`)).toBe('node server.js sk-…34');
    expect(maskSecrets(`https://relay.example.com/${CTX7}/sse`)).toBe(
      'https://relay.example.com/ctx…a0/sse'
    );
    expect(maskSecrets(`https://a.example.com/mcp?profile=${GITHUB}`)).toBe(
      'https://a.example.com/mcp?profile=ghp…23'
    );
    expect(maskSecrets(`--header Authorization:${OPENAI}`)).toBe('--header Authorization:sk-…34');
    // JWT（三段，中间带点）整个算一个 token
    expect(maskSecrets('connect eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlMTIz')).toBe(
      'connect eyJ…Iz'
    );
    // 不到 20 个字符的不算
    expect(maskSecrets('npx sk-short-name')).toBe('npx sk-short-name');
  });

  it('Authorization 之类的头：Bearer / Basic 之后的凭据、键名含密钥词的头的值', () => {
    expect(
      maskSecrets(
        'npx mcp-remote https://a.example.com/mcp --header Authorization: Bearer abc123456789'
      )
    ).toBe('npx mcp-remote https://a.example.com/mcp --header Authorization: Bearer abc…89');
    expect(maskSecrets('--header Authorization:Bearer abc123456789')).toBe(
      '--header Authorization:Bearer abc…89'
    );
    expect(maskSecrets('--header X-API-Key: abc123456789')).toBe('--header X-API-Key: abc…89');
    expect(maskSecrets('--header X-API-Key:abc123456789')).toBe('--header X-API-Key:abc…89');
  });

  it('太短的值整个遮住：留前 3 后 2 会露出大半', () => {
    expect(maskSecrets('server --password hunter2')).toBe('server --password …');
    expect(maskSecrets('https://a.example.com/?token=abc')).toBe('https://a.example.com/?token=…');
  });

  it('不误伤：普通命令、路径、短数字、变量引用、没有密钥的 URL', () => {
    const untouched = [
      'npx -y @modelcontextprotocol/server-filesystem /Users/me/projects/fynvra',
      'cmd /c npx -y @upstash/context7-mcp',
      'C:\\Users\\me\\AppData\\Local\\Programs\\mcp\\server.exe --port 8080',
      'uvx mcp-server-git --repository ~/code/fynvra',
      'server --key ./certs/client.key --token C:\\secrets\\token.txt',
      'server -k 5 --token 42',
      `server --api-key ${ref('CONTEXT7_API_KEY')} --token $GITHUB_TOKEN --password %DB_PASSWORD%`,
      `server --api-key=${ref('input:apiKey')} OPENAI_API_KEY={env:OPENAI_API_KEY}`,
      'https://mcp.figma.com/mcp',
      'https://a.example.com/sse?mode=fast&page=2',
      'https://a.example.com/v1?key=1',
      'npx -y @acme/risk-assessment-toolkit-mcp',
      'curl -k https://a.example.com/health',
      'docker run -e HF_HUB_ENABLE_HF_TRANSFER=1 ghcr.io/acme/mcp:latest',
      '',
    ];
    for (const text of untouched) expect(maskSecrets(text)).toBe(text);
  });

  it('保留原有空白；打过码的文字再打一次不变', () => {
    const once = maskSecrets(`a  --api-key\t${CTX7}  https://x.example.com/?token=${TAVILY}`);
    expect(once).toBe('a  --api-key\tctx…a0  https://x.example.com/?token=tvl…o4');
    expect(maskSecrets(once)).toBe(once);
  });
});
