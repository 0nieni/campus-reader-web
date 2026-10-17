import type { Connection } from './model-provider';

export const failureMessages: Record<string, string> = {
  KEY_REJECTED: '服务商拒绝了 API Key，请检查 Netlify 中 AI_CHAT_API_KEY 是否有效并已重新部署。',
  BALANCE_REQUIRED: 'DeepSeek API 账户余额不足，请在 DeepSeek 平台检查余额；网站每日次数不代表服务商余额。',
  PROVIDER_LIMIT: '服务商限频或并发额度已满，请稍后再手动创建任务。',
  MODEL_OR_CONTEXT_INVALID: '服务商拒绝了模型或请求参数，请核对模型 ID、接口地址及资料长度。',
  MODEL_UNSUPPORTED: '服务商找不到配置的模型或接口，请核对 AI_CHAT_MODEL 和 AI_CHAT_BASE_URL。',
  OUTPUT_TRUNCATED: '模型本批输出未完整结束，可能达到长度限制；本任务已停止，请减少资料或关注点后重新创建。',
  MODEL_FORMAT_INVALID: '服务商未返回有效的完整文本，请检查模型是否支持 Chat Completions。',
  RESPONSE_TOO_LARGE: '模型响应超过读取上限，本任务已停止，请缩小资料范围。',
};
export const providerHttpCode = (status: number) => status === 401 || status === 403 ? 'KEY_REJECTED'
  : status === 402 ? 'BALANCE_REQUIRED' : status === 429 ? 'PROVIDER_LIMIT'
  : status === 400 || status === 422 ? 'MODEL_OR_CONTEXT_INVALID' : status === 404 ? 'MODEL_UNSUPPORTED' : 'PROVIDER_ERROR';

/** Only fixed, read-only DeepSeek metadata endpoints; no prompts or model calls. */
export async function diagnoseOfficial(connection: Connection, endpoint: string, request: typeof fetch = fetch): Promise<{ code: string; message: string }> {
  if (!['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1/chat/completions'].includes(endpoint)) {
    return { code: 'CHECK_UNSUPPORTED', message: '只读连接检查目前支持 DeepSeek 官方接口；未发送模型请求。' };
  }
  async function metadata(path: '/user/balance' | '/models'): Promise<any> {
    const response = await request(`https://api.deepseek.com${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw { code: providerHttpCode(response.status) };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty');
    let text = '', bytes = 0; const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256000) { await reader.cancel(); throw new Error('large'); }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  }
  try {
    const balance = await metadata('/user/balance');
    if (balance.is_available === false) return { code: 'BALANCE_REQUIRED', message: failureMessages.BALANCE_REQUIRED! };
    if (balance.is_available !== true) throw new Error('invalid-balance');
    const models = await metadata('/models');
    if (!Array.isArray(models.data) || models.data.some((model: any) => typeof model?.id !== 'string')) throw new Error('invalid-models');
    if (!models.data.some((model: any) => model.id === connection.model)) return { code: 'MODEL_UNSUPPORTED', message: failureMessages.MODEL_UNSUPPORTED! };
    return { code: 'READY', message: 'Key 验证通过、API 余额可用，模型在可用列表中。未调用模型、未扣网站次数；这不代表本次资料已生成成功。' };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return code && Object.prototype.hasOwnProperty.call(failureMessages, code) ? { code, message: failureMessages[code]! }
      : { code: 'CHECK_FAILED', message: '未完成服务商只读检查，请检查网络或稍后再试；没有发送模型请求。' };
  }
}
