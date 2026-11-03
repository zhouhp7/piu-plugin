export class PiuError extends Error {
  constructor(code, message) { super(message); this.name = 'PiuError'; this.code = code; }
}
export function publicError(error) {
  if (error instanceof PiuError) return error.message;
  return '操作未完成，请稍后重试；管理员可检查服务器网络和配置。';
}
