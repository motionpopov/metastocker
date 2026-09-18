import './local-ai.js?v=2.17';

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
  // Decoder-only generation must align the final prompt token in every row.
  processor.tokenizer.padding_side = 'left';
  const thinkingTemplate = processor.apply_chat_template([{ role: 'user', content: [{ type: 'text', text: 'Describe an image.' }] }], { add_generation_prompt: true, enable_thinking: true });
  if (!thinkingTemplate.includes('<think>') && !thinkingTemplate.includes('<|think|>')) {
    throw new Error('This model template cannot enable thinking. Choose another local model.');
  }
  model = await runtime.AutoModelForImageTextToText.from_pretrained(selected.repo, {
    ...options, dtype: selected.dtype || 'q4f16', device: 'webgpu'
  });
  if (selected.family === 'qwen3_5') isolateQwenVision(model);
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

function isolateQwenVision(loadedModel) {
  const encodeImage = loadedModel.encode_image.bind(loadedModel);
  loadedModel.encode_image = async ({ pixel_values, image_grid_thw }) => {
    const grids = image_grid_thw.tolist();
    if (grids.length === 1) return encodeImage({ pixel_values, image_grid_thw });
    const features = [];
    let offset = 0;
    try {
      // Keep each image's visual attention isolated in the pinned ONNX export.
      // Reuse the SAME encoder session; the language decoder still runs one
      // tensor batch with all independent requests and shared model weights.
      for (let index = 0; index < grids.length; index++) {
        const count = grids[index].reduce((n, value) => n * Number(value), 1);
        const pixels = pixel_values.slice([offset, offset + count]);
        const grid = image_grid_thw.slice([index, index + 1]);
        try { features.push(await encodeImage({ pixel_values: pixels, image_grid_thw: grid })); }
        finally { pixels.dispose?.(); grid.dispose?.(); }
        offset += count;
      }
      return runtime.cat(features, 0);
    } finally { for (const tensor of features) tensor.dispose?.(); }
  };
}

async function prepareRequest({ requestId, prompt, imageDataUrl }) {
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
  return { requestId, text, image };
}

async function prepareInputs(texts, images) {
  const options = { add_special_tokens: false, padding: true };
  if (selected.family === 'gemma4') return processor(texts, images.length ? images : undefined, undefined, options);
  // Qwen2VLProcessor (also used by Qwen3.5 in 4.3.0) drops tokenizer
  // options. Reproduce its image-token expansion, then explicitly left-pad.
  const imageInputs = {};
  const perImage = [];
  try {
    // This Qwen image processor interprets an array as temporal frames of ONE
    // image/video. Process independent images separately, then join patches.
    for (const image of images) perImage.push(await processor.image_processor(image));
    if (perImage.length) {
      for (const key of ['pixel_values', 'image_grid_thw']) imageInputs[key] = runtime.cat(perImage.map(item => item[key]), 0);
    }
    const grids = imageInputs.image_grid_thw?.tolist() || [];
    const mergeLength = processor.image_processor.config.merge_size ** 2;
    let imageIndex = 0;
    const expanded = texts.map(text => text.replaceAll('<|image_pad|>', () => {
      const grid = grids[imageIndex++];
      if (!grid) throw new Error('Image and prompt counts do not match.');
      const count = grid.reduce((product, n) => product * Number(n), 1) / mergeLength;
      return '<|image_pad|>'.repeat(count);
    }));
    if (imageIndex !== grids.length) throw new Error('Image and prompt counts do not match.');
    return { ...processor.tokenizer(expanded, options), ...imageInputs };
  } catch (error) {
    for (const tensor of Object.values(imageInputs)) tensor?.dispose?.();
    throw error;
  } finally {
    for (const item of perImage) for (const tensor of Object.values(item)) {
      if (!Object.values(imageInputs).includes(tensor)) tensor?.dispose?.();
    }
  }
}

async function generateBatch({ id, modelId, requests }) {
  if (!model || selected?.id !== modelId) throw new Error('Load the selected model first.');
  if (!Array.isArray(requests) || !requests.length || requests.length > 20
    || requests.some(item => !Number.isSafeInteger(item?.requestId))
    || new Set(requests.map(item => item.requestId)).size !== requests.length) throw new Error('Invalid local batch.');
  const prepared = [];
  const results = [];
  // Decode in order so that image features and placeholders stay aligned,
  // including batches mixing image requests with text-only category requests.
  for (const request of requests) {
    try { prepared.push(await prepareRequest(request)); }
    catch (error) { results.push({ requestId: request.requestId, error: error.message }); }
  }
  if (!prepared.length) return results;
  let inputs;
  let outputs;
  let generatedTokens = 0;
  let lastProgress = 0;
  try {
    inputs = await prepareInputs(prepared.map(item => item.text), prepared.flatMap(item => item.image ? [item.image] : []));
    if (inputs.input_ids.dims[0] !== prepared.length) throw new Error('The runtime did not prepare the requested batch.');
    if (selected.family === 'gemma4') {
      // The pinned Gemma export degrades left-padded rows on WebGPU. Batch
      // equal-length prompts without padding; never alter a prompt to fit.
      const groups = groupByPromptLength(inputs.attention_mask.tolist());
      if (groups.length > 1) {
        for (const tensor of Object.values(inputs)) tensor?.dispose?.();
        inputs = null;
        for (const group of groups) {
          const ids = new Set(group.map(index => prepared[index].requestId));
          results.push(...await generateBatch({ id, modelId, requests: requests.filter(item => ids.has(item.requestId)) }));
        }
        return results;
      }
    }
    self.postMessage({ id, type: 'progress', batchSize: prepared.length, tokens: 0, message: 'Thinking and generating on this device…' });
    const promptLength = inputs.input_ids.dims.at(-1);
    const configuredEos = model.generation_config.eos_token_id ?? model.config.text_config?.eos_token_id ?? model.config.eos_token_id;
    const eosIds = new Set((Array.isArray(configuredEos) ? configuredEos : [configuredEos]).map(Number));
    if (!eosIds.size || [...eosIds].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Missing model end-of-answer token.');
    const eosToken = [...eosIds][0];
    const finished = new Set();
    const logits_processor = new runtime.LogitsProcessorList();
    let transition;
    if (selected.thinkingTokens) {
      const endTokens = processor.tokenizer.encode('</think>', { add_special_tokens: false });
      if (endTokens.length !== 1) throw new Error('This model cannot apply its thinking budget.');
      transition = processor.tokenizer.encode('</think>\n\n{', { add_special_tokens: false }).map(Number);
      if (transition[0] !== Number(endTokens[0])) throw new Error('This model cannot start its JSON response.');
    }
    logits_processor.push(new class extends runtime.LogitsProcessor {
      _call(inputIds, scores) {
        for (let i = 0; i < inputIds.length; i++) {
          const row = scores[i].data;
          let forced = null;
          // 4.3.0 stops the whole batch only when every row ends on EOS in the
          // same step. Hold completed rows at EOS while other rows continue.
          if (finished.has(i) || (inputIds[i].length > promptLength && eosIds.has(Number(inputIds[i].at(-1))))) {
            finished.add(i);
            forced = eosToken;
          } else if (transition) {
            applyPresencePenalty(row, inputIds[i], promptLength, selected.presencePenalty || 0);
            forced = thinkingBudgetToken(inputIds[i], promptLength, selected.thinkingTokens, transition);
          }
          if (forced !== null) {
            row.fill(-Infinity);
            row[forced] = 0;
          }
        }
        return scores;
      }
    }());
    let isPrompt = true;
    outputs = await model.generate({
      ...inputs, max_new_tokens: selected.maxNewTokens || 4096, logits_processor,
      do_sample: true, temperature: selected.family === 'gemma4' ? 1.0 : 0.6,
      top_p: 0.95, top_k: selected.family === 'gemma4' ? 64 : 20,
      repetition_penalty: selected.family === 'gemma4' ? 1.05 : 1.0,
      // TextStreamer supports only one row. Count tokens without decoding or
      // exposing reasoning, for every still-active sequence in this batch.
      streamer: {
        put(rows) {
          if (isPrompt) { isPrompt = false; return; }
          generatedTokens += rows.reduce((count, row, index) => count + (finished.has(index) ? 0 : row.length), 0);
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          self.postMessage({ id, type: 'progress', batchSize: prepared.length, tokens: generatedTokens, message: `Thinking locally · batch of ${prepared.length}` });
        },
        end() {}
      }
    });
    const generated = outputs.tolist().map(row => {
      const tokens = row.slice(promptLength);
      const end = tokens.findIndex(token => eosIds.has(Number(token)));
      return end < 0 ? tokens : tokens.slice(0, end);
    });
    if (generated.length !== prepared.length) throw new Error('The runtime returned an incomplete batch.');
    // Preserve reasoning delimiters until the final answer has been isolated.
    const decoded = processor.batch_decode(generated, { skip_special_tokens: false });
    for (let index = 0; index < prepared.length; index++) {
      const { requestId, text } = prepared[index];
      try {
        const finalText = extractFinalResponse(decoded[index], /<think>\s*$/.test(text));
        if (!finalText) throw new Error('The model returned an empty response.');
        results.push({ requestId, text: finalText });
      } catch (error) { results.push({ requestId, error: error.message }); }
    }
    return results;
  } finally {
    outputs?.dispose?.();
    if (inputs) for (const tensor of Object.values(inputs)) tensor?.dispose?.();
  }
}

function groupByPromptLength(masks) {
  const groups = new Map();
  masks.forEach((row, index) => {
    const length = row.reduce((sum, value) => sum + Number(value), 0);
    if (!groups.has(length)) groups.set(length, []);
    groups.get(length).push(index);
  });
  return [...groups.values()];
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
    else if (type === 'generateBatch') result = await generateBatch(data);
    else throw new Error('Unknown local operation.');
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error?.message || 'Local model failed. Try a smaller model or another browser.' });
  } finally { busy = false; }
};
