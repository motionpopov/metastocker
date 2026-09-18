/* Shared, deliberately small: choosing a model never downloads the runtime or weights. */
(function (root) {
  'use strict';
  const scriptURL = typeof document !== 'undefined' ? document.currentScript?.src : undefined;
  const CACHE_PREFIX = 'metastocker-local-v1-';
  const MANIFEST_PATH = '/__metastocker_local_model__';
  const MODELS = Object.freeze([
    Object.freeze({
      id: 'local-qwen-2b', label: 'Qwen3.5 2B', family: 'qwen3_5',
      repo: 'onnx-community/Qwen3.5-2B-ONNX-OPT', revision: '2ea7886f48b926aca97de8b0e041ffca7e3ebaa9',
      bytes: 2250000000, size: '2.3 GB', memory: '8 GB+ device memory recommended',
      description: 'Compact vision model with thinking for local image metadata.',
      dtype: Object.freeze({ embed_tokens: 'q4', decoder_model_merged: 'q4', vision_encoder: 'fp16' }),
      maxImageEdge: 768, thinkingTokens: 512, maxNewTokens: 2048, presencePenalty: 1.5,
      binaryFiles: ['embed_tokens_q4.onnx', 'embed_tokens_q4.onnx_data', 'decoder_model_merged_q4.onnx', 'decoder_model_merged_q4.onnx_data', 'vision_encoder_fp16.onnx', 'vision_encoder_fp16.onnx_data']
    }),
    Object.freeze({
      id: 'local-gemma-e2b', label: 'Gemma 4 E2B', family: 'gemma4',
      repo: 'onnx-community/gemma-4-E2B-it-ONNX', revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
      bytes: 3450000000, size: '3.5 GB', memory: '8 GB+ device memory recommended',
      description: 'Compact Gemma model for local image understanding.',
      binaryFiles: ['embed_tokens_q4f16.onnx', 'embed_tokens_q4f16.onnx_data', 'decoder_model_merged_q4f16.onnx', 'decoder_model_merged_q4f16.onnx_data', 'vision_encoder_q4f16.onnx', 'vision_encoder_q4f16.onnx_data', 'audio_encoder_q4f16.onnx', 'audio_encoder_q4f16.onnx_data']
    }),
    Object.freeze({
      id: 'local-gemma-e4b', label: 'Gemma 4 E4B', family: 'gemma4',
      repo: 'onnx-community/gemma-4-E4B-it-ONNX', revision: '843f250f23bc91754def1e0f0db390dacd1e6b05',
      bytes: 5250000000, size: '5.3 GB', memory: '16 GB+ device memory recommended',
      description: 'Larger model for capable computers. Uses more memory.',
      binaryFiles: ['embed_tokens_q4f16.onnx', 'embed_tokens_q4f16.onnx_data', 'decoder_model_merged_q4f16.onnx', 'decoder_model_merged_q4f16.onnx_data', 'decoder_model_merged_q4f16.onnx_data_1', 'vision_encoder_q4f16.onnx', 'vision_encoder_q4f16.onnx_data', 'audio_encoder_q4f16.onnx', 'audio_encoder_q4f16.onnx_data']
    })
  ]);
  const getModel = id => MODELS.find(model => model.id === id);
  const cacheName = id => {
    const model = getModel(id);
    if (!model) throw new Error('Unknown local model.');
    return `${CACHE_PREFIX}${id}-${model.revision}`;
  };
  const manifestURL = () => new URL(MANIFEST_PATH, root.location.href).href;

  async function inspectCache(id) {
    const model = getModel(id);
    if (!model || !root.caches || !await root.caches.has(cacheName(id))) return { cached: false, partial: false };
    const cache = await root.caches.open(cacheName(id));
    const keys = await cache.keys();
    const partial = keys.some(key => new URL(key.url).pathname !== MANIFEST_PATH);
    try {
      const response = await cache.match(manifestURL());
      const manifest = response && await response.json();
      if (manifest?.revision !== model.revision || !Array.isArray(manifest.files)) return { cached: false, partial };
      const urls = new Set(keys.map(key => key.url));
      const cached = model.binaryFiles.every(file => [...urls].some(url => url.endsWith(`/onnx/${file}`)))
        && manifest.files.every(url => urls.has(url));
      return { cached, partial };
    } catch { return { cached: false, partial }; }
  }

  async function checkSupport() {
    if (!root.isSecureContext || root.location?.protocol === 'file:') {
      throw new Error('Local AI needs HTTPS or localhost. Open the hosted app, or serve it locally.');
    }
    if (!root.navigator?.gpu) throw new Error('WebGPU is unavailable. Try a current Chrome or Edge browser with graphics acceleration enabled.');
    const adapter = await root.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No compatible GPU was found. Enable graphics acceleration or try another device.');
    if (!adapter.features.has('shader-f16')) throw new Error('This GPU does not support the precision required by these models. Try another browser or device.');
    if (!root.caches) throw new Error('Model storage is unavailable. Try a regular browser window.');
    return true;
  }

  function extractFinalResponse(raw, thinkingPrefix = false) {
    let text = String(raw || '');
    const thinkEnd = text.lastIndexOf('</think>');
    if (thinkEnd >= 0) text = text.slice(thinkEnd + '</think>'.length);
    else if (thinkingPrefix || text.includes('<think>')) throw new Error('The model reached its thinking limit before producing a final answer. Try fewer tags or a larger model.');
    const thoughtStart = text.lastIndexOf('<|channel>thought');
    if (thoughtStart >= 0) {
      const thoughtEnd = text.indexOf('<channel|>', thoughtStart);
      if (thoughtEnd < 0) throw new Error('The model reached its thinking limit before producing a final answer. Try fewer tags or a larger model.');
      text = text.slice(thoughtEnd + '<channel|>'.length);
    }
    return text.replace(/<\|channel>final\s*|<channel\|>|<turn\|>|<eos>|<pad>|<\|(?:im_end|endoftext|eot_id)\|>/g, '').trim();
  }

  // Close Qwen's native thinking block after its budget, then prefill the JSON
  // opening. Naturally finished reasoning can transition to the answer sooner.
  function thinkingBudgetToken(inputIds, promptLength, budget, transition) {
    const generated = inputIds.slice(promptLength);
    const closedAt = generated.findIndex(token => Number(token) === transition[0]);
    if (closedAt < 0) return generated.length >= budget ? transition[0] : null;
    const next = generated.length - closedAt;
    return next < transition.length ? transition[next] : null;
  }

  function applyPresencePenalty(scores, inputIds, promptLength, penalty) {
    for (const token of new Set(inputIds.slice(promptLength).map(Number))) scores[token] -= penalty;
  }

  class Client {
    constructor(onChange = () => {}, workerFactory) {
      this.onChange = onChange;
      this.workerFactory = workerFactory || (() => new Worker(new URL('local-ai-worker.mjs?v=2.9', scriptURL), { type: 'module' }));
      this.worker = null;
      this.pending = new Map();
      this.sequence = 0;
      this.epoch = 0;
      this.state = { phase: 'idle', modelId: null, progress: null, message: '' };
    }
    update(patch) {
      this.state = { ...this.state, ...patch };
      this.onChange(this.state);
    }
    isReady(id) { return this.state.phase === 'ready' && this.state.modelId === id; }
    terminate(error) {
      this.epoch++;
      this.worker?.terminate();
      this.worker = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    }
    cancel() {
      this.terminate(new DOMException('Local operation cancelled.', 'AbortError'));
      this.update({ phase: 'idle', modelId: null, progress: null, message: 'Stopped. Completed downloads can be reused.' });
    }
    fail(error) {
      this.terminate(error);
      this.update({ phase: 'error', progress: null, message: error.message });
    }
    request(type, payload, timeout) {
      return new Promise((resolve, reject) => {
        const id = ++this.sequence;
        const timer = setTimeout(() => this.fail(new Error('Local AI unavailable: operation timed out. Load the model again, or choose a smaller model.')), timeout);
        this.pending.set(id, { resolve, reject, timer });
        try { this.worker.postMessage({ id, type, ...payload }); }
        catch (error) { this.fail(error); }
      });
    }
    async load(id) {
      const model = getModel(id);
      if (!model) throw new Error('Unknown local model.');
      if (['checking', 'loading', 'generating'].includes(this.state.phase)) throw new Error('A local operation is already running.');
      if (this.isReady(id)) return;
      this.terminate(new DOMException('Model changed.', 'AbortError'));
      const epoch = this.epoch;
      this.update({ phase: 'checking', modelId: id, progress: null, message: 'Checking device and storage…' });
      try {
        await checkSupport();
        const cached = await inspectCache(id);
        const storage = await root.navigator.storage?.estimate?.();
        if (epoch !== this.epoch) throw new DOMException('Cancelled.', 'AbortError');
        if (!cached.cached && storage?.quota && storage.quota - (storage.usage || 0) < model.bytes * 1.1) {
          throw new Error(`Not enough browser storage for ${model.label}. Free some space or choose a smaller model.`);
        }
        this.worker = this.workerFactory();
        this.worker.onmessage = ({ data }) => {
          if (epoch !== this.epoch || !this.pending.has(data.id)) return;
          if (data.type === 'progress') {
            this.update({ progress: data.progress ?? null, tokens: data.tokens ?? this.state.tokens, message: data.message || 'Loading model…' });
            return;
          }
          const pending = this.pending.get(data.id);
          this.pending.delete(data.id);
          clearTimeout(pending.timer);
          if (data.type === 'error') pending.reject(new Error(data.error));
          else pending.resolve(data.result);
        };
        this.worker.onerror = event => {
          event.preventDefault?.();
          this.fail(new Error('Local AI unavailable: the model worker stopped. Try loading it again or choose a smaller model.'));
        };
        this.worker.onmessageerror = () => this.fail(new Error('Local AI unavailable: the browser could not read the model response.'));
        this.update({ phase: 'loading', message: cached.cached ? 'Loading downloaded model…' : 'Downloading model…' });
        const result = await this.request('load', { modelId: id }, 30 * 60 * 1000);
        if (epoch !== this.epoch) throw new DOMException('Cancelled.', 'AbortError');
        this.update({ phase: 'ready', progress: 100, message: result.cached ? 'Ready on this device. Download saved in this browser.' : 'Ready for this tab. Browser storage could not save the full download.' });
        // A denied persistence request is normal: browsers can still use their ordinary cache.
        void root.navigator.storage?.persist?.().catch(() => {});
      } catch (error) {
        if (epoch === this.epoch) this.fail(error);
        throw error;
      }
    }
    async generate({ model, prompt, imageDataUrl }) {
      if (!this.isReady(model)) throw new Error('Local AI unavailable: load the selected model first.');
      const epoch = this.epoch;
      this.update({ phase: 'generating', progress: null, tokens: 0, message: 'Thinking and generating on this device…' });
      try {
        const result = await this.request('generate', { modelId: model, prompt, imageDataUrl }, 10 * 60 * 1000);
        if (epoch === this.epoch) this.update({ phase: 'ready', message: 'Ready on this device.' });
        return result;
      } catch (error) {
        if (epoch === this.epoch) this.fail(new Error(`Local AI unavailable: ${error.message}`));
        if (error.name === 'AbortError') throw error;
        throw new Error(`Local AI unavailable: ${error.message}`);
      }
    }
    async remove(id) {
      cacheName(id); // Validate the allowlist before touching storage.
      if (['checking', 'loading', 'generating'].includes(this.state.phase)) throw new Error('Stop the local operation before removing a model.');
      if (this.state.modelId === id) this.cancel();
      if (root.caches) await root.caches.delete(cacheName(id));
      this.update({ message: 'Model removed from this browser.' });
    }
  }

  // Each slot owns an independent worker and GPU sessions. Sharing one model
  // instance would only queue concurrent calls, not run them in parallel.
  class Pool {
    constructor(onChange = () => {}, workerFactory) {
      this.onChange = onChange;
      this.workerFactory = workerFactory;
      this.clients = [];
      this.epoch = 0;
      this.loading = false;
      this.suspended = false;
      this.target = 1;
      this.state = { phase: 'idle', modelId: null, progress: null, message: '' };
    }
    update(patch) {
      this.state = { ...this.state, ...patch };
      this.onChange(this.state);
    }
    isReady(id, count = 1) {
      return this.state.phase === 'ready' && this.state.modelId === id
        && this.clients.length === count && this.clients.every(client => client.isReady(id));
    }
    childChanged(client) {
      if (this.suspended) return;
      if (this.loading) {
        const index = this.clients.indexOf(client);
        this.update({ phase: 'loading', progress: client.state.progress,
          message: `Thread ${index + 1} of ${this.target}: ${client.state.message}` });
        return;
      }
      const failed = this.clients.find(item => item.state.phase === 'error');
      if (failed) { this.update({ phase: 'error', progress: null, message: failed.state.message }); return; }
      const active = this.clients.filter(item => item.state.phase === 'generating').length;
      const tokens = this.clients.filter(item => item.state.phase === 'generating').reduce((sum, item) => sum + (item.state.tokens || 0), 0);
      this.update({ phase: active ? 'generating' : 'ready', progress: null,
        message: active ? `Thinking locally · ${active} of ${this.clients.length} threads active${tokens ? ` · ${tokens} tokens generated` : ''}` : `${this.clients.length} local thread${this.clients.length === 1 ? '' : 's'} ready.` });
    }
    cancel() {
      this.epoch++;
      this.loading = false;
      this.suspended = true;
      this.clients.forEach(client => client.cancel());
      this.clients = [];
      this.suspended = false;
      this.update({ phase: 'idle', modelId: null, progress: null, message: 'Stopped. Completed downloads can be reused.' });
    }
    async load(id, count = 1) {
      if (!getModel(id)) throw new Error('Unknown local model.');
      if (this.loading || this.clients.some(client => client.state.phase === 'generating')) throw new Error('Stop the local operation first.');
      count = Math.max(1, Math.min(20, Math.floor(Number(count) || 1)));
      if (this.isReady(id, count)) return;
      if (this.state.modelId && this.state.modelId !== id) this.cancel();
      const epoch = this.epoch;
      this.target = count;
      this.loading = true;
      this.suspended = true;
      this.clients.splice(count).forEach(client => client.cancel());
      this.suspended = false;
      this.update({ phase: 'loading', modelId: id, progress: null, message: `Preparing ${count} local thread${count === 1 ? '' : 's'}…` });
      try {
        // Initialize sequentially: the first slot downloads once; later slots
        // read the same cache and allocate their own GPU memory.
        for (let index = 0; index < count; index++) {
          if (epoch !== this.epoch) throw new DOMException('Cancelled.', 'AbortError');
          if (!this.clients[index]) {
            const client = new Client(() => this.childChanged(client), this.workerFactory);
            this.clients.push(client);
          }
          await this.clients[index].load(id);
        }
        if (epoch !== this.epoch) throw new DOMException('Cancelled.', 'AbortError');
        this.loading = false;
        const saved = await inspectCache(id);
        if (epoch !== this.epoch) throw new DOMException('Cancelled.', 'AbortError');
        this.update({ phase: 'ready', progress: 100,
          message: `${count} local thread${count === 1 ? '' : 's'} ready. ${saved.cached ? 'Download saved in this browser.' : 'Ready for this tab; the browser could not save the full download.'}` });
      } catch (error) {
        if (epoch === this.epoch) {
          this.loading = false;
          this.update({ phase: 'error', progress: null, message: `${error.message} Try fewer threads or a smaller model.` });
        }
        throw error;
      }
    }
    async generate(options) {
      if (this.loading || this.state.phase === 'error') throw new Error('Local AI unavailable: prepare the selected model and threads first.');
      const client = this.clients.find(item => item.isReady(options.model));
      if (!client) throw new Error('Local AI unavailable: no prepared worker is available.');
      return client.generate(options);
    }
    unload() {
      if (this.loading || this.clients.some(client => client.state.phase === 'generating')) {
        throw new Error('Stop the local operation before unloading the model.');
      }
      this.cancel();
      this.update({ message: 'Model unloaded from memory. Load it again to continue; saved downloads are kept.' });
    }
    async remove(id) {
      cacheName(id);
      if (this.loading || this.clients.some(client => client.state.phase === 'generating')) throw new Error('Stop the local operation before removing a model.');
      if (this.state.modelId === id) this.cancel();
      if (root.caches) await root.caches.delete(cacheName(id));
      this.update({ message: 'Model removed from this browser.' });
    }
  }

  const api = { MODELS, getModel, cacheName, manifestURL, inspectCache, checkSupport, extractFinalResponse, thinkingBudgetToken, applyPresencePenalty, Client, Pool };
  root.MetaStockerLocalAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
