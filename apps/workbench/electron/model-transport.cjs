const http = require('node:http');
const https = require('node:https');
const { ProxyAgent } = require('proxy-agent');

// SSE is only used for the model's HTTPS response. Desktop events use Electron IPC.
function requestModel(target, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const agent = new ProxyAgent();
    let body = '';
    let pending = '';
    let settled = false;
    const streamEvents = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      agent.destroy();
      if (error) reject(error); else resolve(value);
    };
    const parseFrame = (frame) => {
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      streamEvents.push(event);
      options.onEvent?.(event);
    };
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'POST', headers: options.headers, agent,
      timeout: options.timeoutMs || 60000,
    }, (response) => {
      const isSse = String(response.headers['content-type'] || '').includes('text/event-stream');
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (settled) return;
        body += chunk;
        if (Buffer.byteLength(body) > 32 * 1024 * 1024) {
          request.destroy(new Error('模型返回内容超过 32 MiB 限制'));
          return;
        }
        if (isSse) {
          pending += chunk;
          pending = pending.replace(/\r\n/g, '\n');
          let boundary;
          try {
            while ((boundary = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              parseFrame(frame);
            }
          } catch (error) { request.destroy(error); }
        }
      });
      response.on('aborted', () => finish(new Error('模型响应流意外中断')));
      response.on('error', (error) => finish(error));
      response.on('end', () => {
        try {
          if (isSse && pending.trim()) parseFrame(pending);
          finish(undefined, { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, streamEvents, async text() { return body; } });
        } catch (error) { finish(error); }
      });
    });
    const abort = () => request.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error('模型请求已取消'));
    request.on('timeout', () => request.destroy(Object.assign(new Error('模型请求超时'), { code: 'MODEL_TIMEOUT' })));
    request.on('error', (error) => finish(error));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else request.end(options.body);
  });
}

module.exports = { requestModel };
