export type TokenConfig = {
  appId?: string;
  appSecret?: string;
  host?: string;
  fetchImpl?: typeof fetch;
};

export class FeishuTokenProvider {
  private tokenValue: string | null = null;
  private expiresAt = 0;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TokenConfig = {}) {
    this.appId = config.appId ?? process.env.APP_ID ?? '';
    this.appSecret = config.appSecret ?? process.env.APP_SECRET ?? '';
    this.host = config.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async token(): Promise<string> {
    if (this.tokenValue && this.expiresAt - Date.now() > 30_000) {
      return this.tokenValue;
    }

    if (!this.appId || !this.appSecret) {
      throw new Error('Missing APP_ID or APP_SECRET for Feishu authentication.');
    }

    const response = await this.fetchImpl(`${this.host}/open-apis/auth/v3/tenant_access_token/internal/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret
      })
    });

    const payload = await response.json() as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Feishu auth failed: ${payload.msg ?? response.statusText}`);
    }

    this.tokenValue = payload.tenant_access_token;
    this.expiresAt = Date.now() + ((payload.expire ?? 7200) - 60) * 1000;
    return this.tokenValue;
  }
}
