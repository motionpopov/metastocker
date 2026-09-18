# Local browser batching

MetaStocker v2.17 keeps one `Client`, one module Worker and one loaded Transformers.js model per page. `Pool.generate()` keeps the existing per-file Promise interface but gathers pending requests for 120 ms and sends at most the selected batch size in one `generateBatch` message. Further batches use the same model. This is static tensor batching, not continuous insertion into an already-running generation. A slow file preview may join a later batch.

The app's frozen run configuration caps concurrent file pipelines. Qwen joins ready prompts into a left-padded tensor and calls `model.generate()` once. Gemma groups prompts by their actual token length, then generates each group without padding on the same model: the pinned export produced corrupted answers for padded rows in a real WebGPU test, while equal-length batches and individual requests were correct. Different image proportions and prompt lengths can therefore reduce Gemma's effective batch size, sometimes to one. Progress shows the actual tensor batch size. Prompts and image content are never altered to fit a group.

Image, text-only category and keyword-retry requests can share a compatible batch. Model thinking remains enabled independently for each prompt. Request IDs match each final answer to its file. An invalid final answer rejects that item; a runtime failure rejects the active and queued requests and terminates the worker. Cancellation also terminates the worker and rejects all promises; cached weights remain available.

The pinned Transformers.js 4.3.0 runtime needs three adaptations:

- Qwen's inherited processor drops tokenization options. Image placeholders are expanded explicitly before tokenization with padding. Its image processor treats arrays as temporal frames, so independent images are preprocessed separately and their patches/grid tensors are concatenated in prompt order. Visual encoding also runs separately for each image through the same encoder session to isolate visual attention in the pinned export; language decoding runs as one tensor batch.
- `TextStreamer` only supports a single row. A token-count streamer reports progress without decoding or exposing reasoning.
- Generation waits for all rows to emit EOS in the same step. A logits processor holds finished rows at EOS; final decoding truncates each row at its first generated EOS. Qwen's presence penalty and thinking budget apply to each unfinished row separately.

Pinned model graphs declare dynamic `batch_size` for embeddings, attention masks and KV/recurrent state. That alone does not qualify a browser/GPU: real WebGPU testing remains required after changes to the runtime, model revision, dtype or preprocessing. Unit tests cover scheduling, cancellation, stale replies, identity mapping, mixed inputs, padding, thinking and EOS boundaries. Run them with `node --test tests/*.test.js tests/*.test.mjs`.

For a real GPU smoke test, serve the repository on localhost and open `tests/browser-local-ai.html`. Load one model, run four synthetic images, then a mixed image/text batch and one image. The transport trace must show one worker and one load across these runs, with messages `[4,4,1]`; Gemma can split a message into smaller tensor groups shown in status. Inspect final responses for file association and image content; model mistakes are possible and a transport-level success is not a metadata-quality guarantee. Use Stop / unload to test cancellation and release memory. The release allowlist excludes this page and all other test files.

Larger batches retain one set of weights but add per-input contexts and intermediate tensors. Download size is not a GPU-memory estimate. No automatic safe maximum or speedup is promised; the UI starts at one and warns above two. GPU allocation failures require the user to lower the batch size or select a smaller model, then reload.

## v2.17 verification (2026-09-18)

Tested in Chrome/WebGPU on Apple M1 Max with 64 GB system memory:

- Qwen3.5 2B: four separate image requests in one tensor batch; mixed image/text requests; switching to a single request with the same worker and model load. A blue/purple classification mistake reproduced in both the batch and single control, so output quality still needs review.
- Gemma 4 E2B: four images with equal prompt lengths returned the correct individual colors/shapes and identifiers. Variable-length padding caused corrupted answers before the grouping fix. After the fix, a mixed batch returned all four correct image/text responses on one model.
- Generator UI: increasing Batch size from one to four kept Model ready and Start enabled, with no Prepare-threads step. Unloading retained the browser download.

Gemma 4 E4B, other GPUs/browsers, batches above four, exact GPU-memory use and throughput comparisons were not qualified. Full import-to-CSV browser testing was blocked by the Chrome extension's local-file permission; pipeline routing/validation and CSV behavior passed automated regression tests. The synthetic browser harness verifies model inference independently of the upload control.

Upstream implementation references: [Qwen image processor](https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/src/models/qwen2_vl/image_processing_qwen2_vl.js), [Qwen processor](https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/src/models/qwen2_vl/processing_qwen2_vl.js), [generation loop](https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/src/models/modeling_utils.js), [streamers](https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/src/generation/streamers.js).
