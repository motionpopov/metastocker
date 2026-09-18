import './local-ai.js?v=2.9';

const { getModel, cacheName, manifestURL, inspectCache, extractFinalResponse, thinkingBudgetToken, applyPresencePenalty } = globalThis.MetaStockerLocalAI;
let runtime;
let processor;
let model;
let selected;
let busy = false;

async function load(modelId, id) {
  selected = getModel(modelId);
  if (!selected) throw new Error('Unknown local model.');
  // The runtime and weights are fetched only after the user presses Download & load.
  runtime = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js');
  runtime.env.allowLocalModels = false;
  // The tokenizer's metadata probe does not forward revision in Transformers.js 4.3.0.
  // Pin the URL template as well, so even that probe cannot follow a mutable main branch.
  runtime.env.remotePathTemplate = `{model}/resolve/${selected.revision}/`;
  runtime.env.useBrowserCache = false;
  runtime.env.useCustomCache = true;
  runtime.env.cacheKey = cacheName(modelId);
  runtime.env.backends.onnx.wasm.numThreads = 1;
  const cache = await caches.open(cacheName(modelId));
  const fetchResource = runtime.env.fetch;
  runtime.env.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(`https://huggingface.co/${selected.repo}/resolve/${selected.revision}/`)) {
      const saved = await cache.match(url);
      if (saved) return saved;
    }
    return fetchResource(input, init);
  };
  let cacheFailed = false;
  runtime.env.customCache = {
    match: request => cache.match(request),
    put: async (request, response) => {
      try { await cache.put(request, response); }
      catch (error) { cacheFailed = true; throw error; }
    }
  };
  let aggregateProgress = false;
  const progress_callback = info => {
    if (info.status !== 'progress_total' && info.status !== 'progress' && info.status !== 'ready') return;
    if (info.status === 'progress_total') aggregateProgress = true;
    else if (aggregateProgress) return;
    const progress = info.status === 'progress_total' ? Math.min(99, Math.round(info.progress || 0)) : null;
    self.postMessage({ id, type: 'progress', progress, message: progress === null ? 'Loading model files…' : progress >= 99 ? 'Preparing model on your GPU…' : `Loading model files: ${progress}%` });
  };
  const options = { revision: selected.revision, progress_callback };
  processor = await runtime.AutoProcessor.from_pretrained(selected.repo, options);
  const thinkingTemplate = processor.apply_chat_template([{ role: 'user', content: [{ type: 'text', text: 'Describe an image.' }] }], { add_generation_prompt: true, enable_thinking: true });
  if (!thinkingTemplate.includes('<think>') && !thinkingTemplate.includes('<|think|>')) {
    throw new Error('This model template cannot enable thinking. Choose another local model.');
  }
  model = await runtime.AutoModelForImageTextToText.from_pretrained(selected.repo, {
    ...options, dtype: selected.dtype || 'q4f16', device: 'webgpu'
  });
  let cached = false;
  try {
    const files = (await cache.keys()).map(request => request.url).filter(url => url !== manifestURL());
    if (!cacheFailed && selected.binaryFiles.every(file => files.some(url => url.endsWith(`/onnx/${file}`)))) {
      await cache.put(manifestURL(), new Response(JSON.stringify({ revision: selected.revision, files }), { headers: { 'Content-Type': 'application/json' } }));
      cached = (await inspectCache(modelId)).cached;
    }
  } catch { /* Inference may work even if the browser cannot retain the download. */ }
  return { cached };
}

async function generate({ id, modelId, prompt, imageDataUrl }) {
  if (!model || selected?.id !== modelId) throw new Error('Load the selected model first.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A metadata prompt is required.');
  // Only locally created previews are accepted; the worker never fetches an asset URL.
  if (imageDataUrl && !/^data:image\/(jpeg|png|webp);base64,/i.test(imageDataUrl)) throw new Error('Invalid local image preview.');
  const content = [];
  if (imageDataUrl) content.push({ type: 'image' });
  content.push({ type: 'text', text: selected.thinkingTokens
    ? `${prompt}\n\nKeep your reasoning brief. Inspect the image, choose supported details, then return the requested final JSON without repeatedly reconsidering your answer.`
    : prompt });
  const text = processor.apply_chat_template([{ role: 'user', content }], { add_generation_prompt: true, enable_thinking: true });
  let image = imageDataUrl ? await runtime.RawImage.read(imageDataUrl) : undefined;
  if (image && selected.maxImageEdge && Math.max(image.width, image.height) > selected.maxImageEdge) {
    const scale = selected.maxImageEdge / Math.max(image.width, image.height);
    image = await image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  }
  let inputs;
  let outputs;
  let generatedTokens = 0;
  let lastProgress = 0;
  try {
    inputs = selected.family === 'gemma4'
      ? await processor(text, image, undefined, { add_special_tokens: false })
      : await processor(text, image, { add_special_tokens: false });
    const logits_processor = new runtime.LogitsProcessorList();
    if (selected.thinkingTokens) {
      const endTokens = processor.tokenizer.encode('</think>', { add_special_tokens: false });
      if (endTokens.length !== 1) throw new Error('This model cannot apply its thinking budget.');
      const transition = processor.tokenizer.encode('</think>\n\n{', { add_special_tokens: false }).map(Number);
      if (transition[0] !== Number(endTokens[0])) throw new Error('This model cannot start its JSON response.');
      const promptLength = inputs.input_ids.dims.at(-1);
      const budget = selected.thinkingTokens;
      logits_processor.push(new class extends runtime.LogitsProcessor {
        _call(inputIds, scores) {
          for (let i = 0; i < inputIds.length; i++) {
            const row = scores[i].data;
            // Transformers.js has no built-in presence_penalty option. Apply
            // Qwen's additive penalty once per generated token, excluding input.
            applyPresencePenalty(row, inputIds[i], promptLength, selected.presencePenalty || 0);
            const forced = thinkingBudgetToken(inputIds[i], promptLength, budget, transition);
            if (forced === null) continue;
            row.fill(-Infinity);
            row[forced] = 0;
          }
          return scores;
        }
      }());
    }
    outputs = await model.generate({
      ...inputs, max_new_tokens: selected.maxNewTokens || 4096, logits_processor,
      do_sample: true, temperature: selected.family === 'gemma4' ? 1.0 : 0.6,
      top_p: 0.95, top_k: selected.family === 'gemma4' ? 64 : 20,
      repetition_penalty: selected.family === 'gemma4' ? 1.05 : 1.0,
      streamer: new runtime.TextStreamer(processor.tokenizer, {
        skip_prompt: true,
        callback_function: () => {}, // Never display or log the model's reasoning.
        token_callback_function: tokens => {
          generatedTokens += tokens.length;
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          self.postMessage({ id, type: 'progress', tokens: generatedTokens, message: 'Thinking and generating on this device…' });
        }
      })
    });
    const generated = outputs.slice(null, [inputs.input_ids.dims.at(-1), null]);
    // Preserve reasoning delimiters until the final answer has been isolated.
    const raw = processor.batch_decode(generated, { skip_special_tokens: false })[0];
    const result = extractFinalResponse(raw, /<think>\s*$/.test(text));
    generated.dispose?.();
    if (!result) throw new Error('The model returned an empty response.');
    return result;
  } finally {
    outputs?.dispose?.();
    if (inputs) for (const tensor of Object.values(inputs)) tensor?.dispose?.();
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (busy) {
    self.postMessage({ id, type: 'error', error: 'The local model is already busy.' });
    return;
  }
  busy = true;
  try {
    let result;
    if (type === 'load') result = await load(data.modelId, id);
    else if (type === 'generate') result = await generate(data);
    else throw new Error('Unknown local operation.');
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error?.message || 'Local model failed. Try a smaller model or another browser.' });
  } finally { busy = false; }
};
