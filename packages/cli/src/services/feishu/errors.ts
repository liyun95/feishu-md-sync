export type FeishuApiErrorInput = {
  code?: number;
  status?: number;
  method?: string;
  path?: string;
  requestId?: string;
  responseBody?: unknown;
};

export class FeishuApiError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  readonly requestId?: string;
  readonly responseBody?: unknown;

  constructor(message: string, input: FeishuApiErrorInput = {}) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = input.code;
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.requestId = input.requestId;
    this.responseBody = input.responseBody;
  }
}
