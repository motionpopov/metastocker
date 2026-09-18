'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../local-ai.js');
const source = fs.readFileSync(path.join(__dirname, '../local-ai-worker.mjs'), 'utf8').replace(/^import .*;\n/, '');

function workerHarness(family = 'qwen3_5') {
  const messages = [], tensors = [], calls = [];
  function tensor(dims, rows) {
    const value = { dims, tolist: () => rows, dispose() { this.disposed = true; } };
    tensors.push(value);return value;
  }
  const tokenizer = (texts, options) => {
    calls.push({ texts, options });
    return { input_ids: tensor([texts.length, 3], texts.map(() => [0n, 1n, 2n])), attention_mask: tensor([texts.length, 3],texts.map(()=>[1n,1n,1n])) };
  };
  tokenizer.encode = text => text === '</think>' ? [7] : [7, 8];
  let imageCalls = 0;
  const processor = Object.assign(async (texts, images, audio, options) => processor.tokenizer(texts, options), {
    tokenizer,
    apply_chat_template: messages => `${messages[0].content.some(c => c.type === 'image') ? '<|image_pad|>' : ''}${messages[0].content.at(-1).text}<think>`,
    image_processor: Object.assign(async image => {
      assert.ok(!Array.isArray(image), 'Qwen arrays mean temporal frames, not independent images');
      return {image_grid_thw: tensor([1, 3], [[1n, 2n, BigInt(2 + 2 * imageCalls++)]]), pixel_values: tensor([1, 3, 10, 10], [])};
    }, { config: { merge_size: 2 } }),
    batch_decode: rows => rows.map(row => row[0] === 5n ? 'brief</think>{"item":"one"}' : row[0] === 6n ? 'brief</think>{"item":"two"}' : 'unfinished reasoning')
  });
  let generateCalls = 0;
  const model = {
    generation_config: { eos_token_id: [9, 10] }, config: {},
    async generate(options) {
      generateCalls++;
      assert.equal(options.input_ids.dims[0], 2);
      const lp = options.logits_processor.items[0];
      const scores = [{data:new Float32Array(16)}, {data:new Float32Array(16)}];
      // EOS in a padded prompt cannot stop a row; early EOS in an answer must
      // remain EOS, while the other row independently exhausts thinking budget.
      lp._call([[9n,1n,2n,5n,10n], [9n,1n,2n,4n,4n]], scores);
      assert.equal(scores[0].data[9], 0);
      assert.equal(scores[0].data[5], -Infinity);
      if (family === 'qwen3_5') {
        assert.equal(scores[1].data[7], 0);
        assert.equal(scores[1].data[9], -Infinity);
      } else assert.equal(scores[1].data[9], 0);
      options.streamer.put([[0n,1n,2n],[0n,1n,2n]]);
      options.streamer.put([[9n],[6n]]);
      options.streamer.end();
      return tensor([2,7], [[0n,1n,2n,5n,10n,14n,9n],[0n,1n,2n,6n,6n,6n,9n]]);
    }
  };
  const runtime = { RawImage: { read:async()=>({width:100,height:100}) },
    cat:values=>tensor([values.reduce((n,t)=>n+t.dims[0],0),...values[0].dims.slice(1)],values.flatMap(t=>t.tolist())),
    LogitsProcessor: class {}, LogitsProcessorList:class { items=[];push(item){this.items.push(item);} } };
  const context = vm.createContext({ MetaStockerLocalAI:api,self:{postMessage:m=>messages.push(m)},
    mockProcessor:processor,mockModel:model,mockRuntime:runtime,Date,Set,Number,Error });
  vm.runInContext(source,context);
  vm.runInContext(`processor=mockProcessor;model=mockModel;runtime=mockRuntime;selected={id:'test',family:'${family}',thinkingTokens:${family==='qwen3_5'?2:0}}`,context);
  return {context,calls,tensors,messages,model,processor,tensor,generateCalls:()=>generateCalls};
}

for (const family of ['qwen3_5','gemma4']) test(`${family}: batch generation preserves request identity, EOS boundaries and thinking`, async () => {
  const h=workerHarness(family);
  const results=await h.context.generateBatch({id:1,modelId:'test',requests:[
    {requestId:31,prompt:'Short',imageDataUrl:'data:image/png;base64,AAAA'},
    {requestId:12,prompt:'A longer text-only request'}
  ]});
  assert.equal(h.generateCalls(),1);
  assert.equal(h.calls[0].texts.length,2);
  assert.equal(h.calls[0].options.padding,true);
  assert.equal(h.calls[0].options.add_special_tokens,false);
  assert.deepEqual(Array.from(results,r=>[r.requestId,r.text]),[[31,'{"item":"one"}'],[12,'{"item":"two"}']]);
  assert.ok(h.tensors.every(t=>t.disposed));
  assert.ok(h.messages.every(m=>!JSON.stringify(m).includes('brief')));
});

test('Qwen expands images across rows in order and retains different prompt lengths for padding', async () => {
  const h=workerHarness();
  await h.context.prepareInputs(['a<|image_pad|>','text only','longer<|image_pad|>'],[{},{}]);
  assert.deepEqual(Array.from(h.calls[0].texts),['a<|image_pad|>','text only','longer<|image_pad|><|image_pad|>']);
});

test('Qwen reuses one vision encoder while keeping independent image attention separate', async () => {
  const h=workerHarness();const encoded=[],slices=[];
  const input=kind=>({tolist:()=>[[1n,2n,2n],[1n,2n,4n]],slice(range){
    const part={kind,range,dispose(){this.disposed=true;}};slices.push(part);return part;
  }});
  const model={async encode_image(inputs){const index=encoded.push(inputs);return {dims:[1,2],tolist:()=>[[index,0]],dispose(){}};}};
  h.context.isolateQwenVision(model);
  const result=await model.encode_image({pixel_values:input('pixels'),image_grid_thw:input('grid')});
  assert.equal(encoded.length,2);
  assert.deepEqual(Array.from(encoded[0].pixel_values.range),[0,4]);
  assert.deepEqual(Array.from(encoded[1].pixel_values.range),[4,12]);
  assert.deepEqual(Array.from(result.tolist(), row=>Array.from(row)),[[1,0],[2,0]]);
  assert.ok(slices.every(item=>item.disposed));
});

test('Gemma groups only equally long prompts, retaining all request indices and order', () => {
  const h=workerHarness('gemma4');
  const groups=h.context.groupByPromptLength([[0n,1n,1n],[1n,1n,1n],[0n,1n,1n],[0n,0n,1n]]);
  assert.deepEqual(Array.from(groups,group=>Array.from(group)),[[0,2],[1],[3]]);
});

test('Gemma runs unequal prompts as unpadded tensor groups on the same model', async () => {
  const h=workerHarness('gemma4'), shapes=[];
  h.processor.tokenizer=texts=>{
    const lengths=texts.map(text=>text.includes('Long')?5:3),max=Math.max(...lengths);
    return {input_ids:h.tensor([texts.length,max],texts.map(()=>Array(max).fill(1n))),
      attention_mask:h.tensor([texts.length,max],lengths.map(length=>Array(max-length).fill(0n).concat(Array(length).fill(1n))))};
  };
  h.model.generate=async inputs=>{
    const [count,length]=inputs.input_ids.dims;
    shapes.push([count,length]);
    assert.ok(inputs.attention_mask.tolist().every(row=>row.every(token=>token===1n)));
    return h.tensor([count,length+2],Array.from({length:count},()=>Array(length).fill(1n).concat([5n,9n])));
  };
  const results=await h.context.generateBatch({id:1,modelId:'test',requests:[
    {requestId:31,prompt:'Short'}, {requestId:12,prompt:'Long'}, {requestId:15,prompt:'Short again'}
  ]});
  assert.deepEqual(shapes,[[2,3],[1,5]]);
  assert.deepEqual(Array.from(results,r=>r.requestId),[31,15,12]);
  assert.ok(h.tensors.every(t=>t.disposed));
  assert.deepEqual(Array.from(h.messages,m=>m.batchSize),[2,1]);
});

test('invalid previews fail per item; a GPU failure still disposes prepared input tensors', async () => {
  const h=workerHarness();
  h.model.generate=async()=>{throw new Error('GPU lost');};
  await assert.rejects(h.context.generateBatch({id:1,modelId:'test',requests:[
    {requestId:1,prompt:'Text'}, {requestId:2,prompt:'Image',imageDataUrl:'data:image/png;base64,AAAA'}
  ]}),/GPU lost/);
  assert.ok(h.tensors.every(t=>t.disposed));
  const invalid=await h.context.generateBatch({id:2,modelId:'test',requests:[{requestId:3,prompt:'Image',imageDataUrl:'https://private.example/image'}]});
  assert.match(invalid[0].error,/Invalid local image preview/);
  assert.equal(invalid[0].requestId,3);
});
