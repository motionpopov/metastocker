'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../local-ai.js');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '../local-ai.js'), 'utf8');
function section(start, end) {
  const a = app.indexOf(start), b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return app.slice(a, b);
}

function pipeline(generate) {
  let cloudCalls = 0;
  const controls = {
    '#model': { value: 'local-gemma-e2b' }, '#accessKey': { value: 'a-cloud-key-that-must-stay-out-of-local-jobs' },
    '#tagsCount': { value: '10' }, '#concurrency': { value: '20' }, '#comments': { value: 'Studio photograph' },
    '#alwaysTags': { value: 'studio' }, '#alwaysTagsPosition': { value: 'end' },
    '#outEnvato': { checked: true }, '#outShutter': { checked: true }
  };
  const context = vm.createContext({
    MetaStockerLocalAI: api, localAI: { generate },
    $: selector => controls[selector],
    document: { getElementById: () => null }, localStorage: { getItem: () => null },
    envatoDefaults: {}, addLog: () => {}, sleep: async () => {}, addTokens: () => {},
    workerFetch: async () => { cloudCalls++; throw new Error('Unexpected cloud call'); }
  });
  vm.runInContext([
    section('const MODEL_GPT_6_LUNA', '/************** Column widths **************/'),
    section('function parseAlwaysTags', '/************** Preview builders **************/'),
    section('function isGrokModel', '/************** Table UI **************/')
  ].join('\n'), context);
  return { context, controls, cloudCalls: () => cloudCalls };
}
const metadata = { title: 'Cat relaxing on a sofa', tags: ['cat', 'pet', 'animal', 'feline', 'sofa', 'home', 'relaxation', 'fur', 'whisker', 'domestic'], category: 1 };

for (const { id: model } of api.MODELS) test(`${model}: all metadata stages stay local and receive their image or text context`, async () => {
  const calls = [];
  const p = pipeline(async options => {
    calls.push(options);
    if (options.prompt.includes('title90')) return JSON.stringify({title90: 'Cat on sofa', description300: 'A domestic cat resting indoors.', category: 'Nature'});
    if (options.prompt.includes('ONE or TWO')) return JSON.stringify({categories: 'Animals/Wildlife'});
    return JSON.stringify(metadata);
  });
  const imageDataUrl = 'data:image/jpeg;base64,AAAA';
  assert.equal((await p.context.callAI({model, imageDataUrl, prompt:'Photo metadata', tagsCount:10})).category,1);
  assert.equal((await p.context.fetchEnvatoMeta({model, imageDataUrl, title:metadata.title, tags:metadata.tags, isMG:false})).category,'Nature');
  await p.context.fetchShutterstockCategories({model,filename:'cat.jpg',adobeTitle:metadata.title,adobeKeywords:metadata.tags});
  assert.equal(calls.length,3);
  assert.ok(calls.every(call => call.model === model && !('accessKey' in call)));
  assert.equal(calls[1].imageDataUrl,imageDataUrl);
  assert.equal(calls[2].imageDataUrl,'');
  assert.equal(p.cloudCalls(),0);
});

test('invalid local output is retried, then rejected without cloud fallback', async () => {
  let count=0;
  const p=pipeline(async()=>{count++;return JSON.stringify({...metadata,tags:['cat','CAT'],category:'1'});});
  await assert.rejects(p.context.callAI({model:'local-gemma-e2b',prompt:'Metadata',tagsCount:10}),/could not produce 10 unique tags/);
  assert.equal(count,3);
  assert.equal(p.cloudCalls(),0);
});

test('short keyword responses are supplemented only with new model-generated keywords', async () => {
  const additional=['winter','snow','outdoors','wildlife','nature','coat','cold','walking','paws','mammal'];
  let count=0;
  const p=pipeline(async options=>{
    count++;
    if(count===1)return JSON.stringify(metadata);
    assert.match(options.prompt,/ADDITIONAL/);
    assert.match(options.prompt,/DO NOT repeat/);
    return JSON.stringify({tags:['CAT',...additional]});
  });
  const result=await p.context.callAI({model:'local-gemma-e2b',prompt:'Photo metadata',tagsCount:20});
  assert.equal(result.tags.length,20);
  assert.equal(new Set(result.tags.map(t=>t.toLowerCase())).size,20);
  assert.deepEqual(Array.from(result.tags),[...metadata.tags,...additional]);
  assert.equal(result.category,1);
  assert.equal(count,2);
  assert.equal(p.cloudCalls(),0);
});

test('local runtime errors and cancellation are never rerouted or retried', async () => {
  for (const error of [new Error('GPU lost'),new DOMException('Cancelled','AbortError')]) {
    let count=0;
    const p=pipeline(async()=>{count++;throw error;});
    await assert.rejects(p.context.callAI({model:'local-gemma-e4b',prompt:'Metadata'}),e=>e===error);
    assert.equal(count,1);
    assert.equal(p.cloudCalls(),0);
  }
  const p=pipeline(async()=>{});
  await assert.rejects(p.context.callOpenAI({model:'local-unknown',prompt:'Metadata'}),/cannot use the cloud/);
  assert.equal(p.cloudCalls(),0);
});

test('batch configuration freezes local selection and requested concurrency without cloud credentials', () => {
  const p=pipeline(async()=>{});
  p.controls['#concurrency'].value='2';
  const config=p.context.createRunConfig();
  p.controls['#model'].value='gpt-5.4-mini';
  p.controls['#concurrency'].value='20';
  assert.equal(config.model,'local-gemma-e2b');
  assert.equal(config.provider,'local');
  assert.equal(config.accessKey,'');
  assert.equal(config.concurrency,2);
  assert.ok(Object.isFrozen(config));
  assert.equal(p.context.createRunConfig().concurrency,20);
  assert.match(p.context.buildPrompt(null,config),/21\. Travel/);
});

test('thinking output is isolated before parsing; incomplete thoughts never become metadata', () => {
  const final=JSON.stringify(metadata);
  assert.equal(api.extractFinalResponse(`<think>draft {"category":99}</think>${final}<|im_end|>`),final);
  assert.equal(api.extractFinalResponse(`reasoning with {"tags":[]} </think>${final}`,true),final);
  assert.equal(api.extractFinalResponse(`<|channel>thought\na draft {"category":99}<channel|>${final}<turn|>`),final);
  assert.throws(()=>api.extractFinalResponse('<think>Incomplete reasoning'),/thinking limit/);
  assert.throws(()=>api.extractFinalResponse('Incomplete reasoning',true),/thinking limit/);
  assert.throws(()=>api.extractFinalResponse('<|channel>thought\nIncomplete reasoning'),/thinking limit/);
});

test('Qwen thinking budget closes only generated reasoning and preserves the final answer', () => {
  const transition = [42, 43, 44]; // Closing marker, whitespace, JSON opening.
  // A closing marker in the prompt must not consume or disable the thinking budget.
  const prompt = [1n, 42n, 3n];
  assert.equal(api.thinkingBudgetToken([...prompt, 4n], prompt.length, 2, transition), null);
  assert.equal(api.thinkingBudgetToken([...prompt, 4n, 5n], prompt.length, 2, transition), 42);
  assert.equal(api.thinkingBudgetToken([...prompt, 4n, 5n, 42n], prompt.length, 2, transition), 43);
  assert.equal(api.thinkingBudgetToken([...prompt, 4n, 5n, 42n, 43n], prompt.length, 2, transition), 44);
  assert.equal(api.thinkingBudgetToken([...prompt, 4n, 5n, 42n, 43n, 44n, 6n, 7n], prompt.length, 2, transition), null);
  // Natural early completion also gets a JSON prefix; its reasoning is not extended.
  assert.equal(api.thinkingBudgetToken([...prompt, 42n], prompt.length, 2, transition), 43);
});

test('Qwen presence penalty applies once per generated token and never penalizes prompt-only tokens', () => {
  const scores = new Float32Array([0, 2, -3, 4, 5]);
  api.applyPresencePenalty(scores, [1n, 4n, 2n, 2n, 3n], 2, 1.5);
  assert.deepEqual([...scores], [0, 2, -4.5, 2.5, 5]);
});

function clientEnvironment({gpu=true,space=20e9}={}) {
  const stores=new Map();
  const norm=x=>typeof x==='string'?new URL(x,'https://test.local').href:x.url;
  const caches={
    has:async name=>stores.has(name),
    open:async name=>{
      if (!stores.has(name)) stores.set(name,new Map());
      const store=stores.get(name);
      return {keys:async()=>[...store.keys()].map(url=>({url})),match:async key=>store.get(norm(key))?.clone(),put:async(key,response)=>store.set(norm(key),response.clone())};
    },
    delete:async name=>stores.delete(name)
  };
  const context=vm.createContext({location:{href:'https://test.local/',protocol:'https:'},isSecureContext:true,caches,
    navigator:{gpu:gpu?{requestAdapter:async()=>({features:new Set(['shader-f16'])})}:undefined,storage:{estimate:async()=>({quota:space,usage:0}),persist:async()=>false}},
    URL,Response,DOMException,setTimeout,clearTimeout});
  vm.runInContext(clientSource,context);
  return {api:context.MetaStockerLocalAI,caches,stores};
}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

test('unsupported devices and insufficient storage fail before a worker or download is created', async () => {
  for (const options of [{gpu:false},{space:100}]) {
    const env=clientEnvironment(options);
    let workers=0;
    const client=new env.api.Client(()=>{},()=>{workers++;});
    assert.equal(workers,0);
    await assert.rejects(client.load('local-gemma-e2b'),/WebGPU|storage/);
    assert.equal(workers,0);
    assert.equal(client.state.phase,'error');
  }
});

test('cancellation terminates a download and ignores stale readiness messages', async () => {
  const env=clientEnvironment();
  const worker={postMessage(data){this.last=data;},terminate(){this.stopped=true;}};
  const client=new env.api.Client(()=>{},()=>worker);
  const loading=client.load('local-gemma-e2b');
  const rejection=assert.rejects(loading,e=>e.name==='AbortError');
  await nextTurn();
  assert.equal(client.state.phase,'loading');
  client.cancel();
  worker.onmessage({data:{id:worker.last.id,type:'result',result:{cached:true}}});
  await rejection;
  assert.equal(worker.stopped,true);
  assert.equal(client.isReady('local-gemma-e2b'),false);
  assert.equal(client.state.phase,'idle');
});

test('ready client serializes inference and releases resources when cancelled', async () => {
  const env=clientEnvironment();
  const worker={postMessage(data){this.last=data;if(data.type==='load')queueMicrotask(()=>this.onmessage({data:{id:data.id,type:'result',result:{cached:true}}}));},terminate(){this.stopped=true;}};
  const client=new env.api.Client(()=>{},()=>worker);
  await client.load('local-gemma-e2b');
  assert.ok(client.isReady('local-gemma-e2b'));
  const generation=client.generateBatch({model:'local-gemma-e2b',requests:[{requestId:1,prompt:'Describe'}]});
  const cancelled=assert.rejects(generation,e=>e.name==='AbortError');
  await assert.rejects(client.generateBatch({model:'local-gemma-e2b',requests:[{requestId:2,prompt:'Another'}]}),/load the selected model/);
  client.cancel();
  await cancelled;
  assert.equal(worker.stopped,true);
  assert.equal(client.pending.size,0);
});

test('cache checks distinguish complete, evicted and partial models; removal is scoped', async () => {
  const env=clientEnvironment();
  const id='local-gemma-e2b',model=env.api.getModel(id);
  const cache=await env.caches.open(env.api.cacheName(id));
  const urls=model.binaryFiles.map(file=>`https://huggingface.co/${model.repo}/resolve/${model.revision}/onnx/${file}`);
  for (const url of urls) await cache.put(url,new Response('model'));
  assert.equal((await env.api.inspectCache(id)).cached,false);
  assert.equal((await env.api.inspectCache(id)).partial,true);
  await cache.put(env.api.manifestURL(),new Response(JSON.stringify({revision:model.revision,files:urls})));
  assert.equal((await env.api.inspectCache(id)).cached,true);
  env.stores.get(env.api.cacheName(id)).delete(urls[0]);
  assert.equal((await env.api.inspectCache(id)).cached,false);
  await env.caches.open('unrelated-user-data');
  const client=new env.api.Client();
  await client.remove(id);
  assert.equal(await env.caches.has(env.api.cacheName(id)),false);
  assert.equal(await env.caches.has('unrelated-user-data'),true);
  await assert.rejects(client.remove('unrelated-user-data'),/Unknown local model/);
});

function batchEnvironment() {
  const env=clientEnvironment();
  const workers=[];
  const pool=new env.api.Pool(()=>{},()=>{
    const worker={messages:[],postMessage(data){this.messages.push(data);this.last=data;if(data.type==='load')queueMicrotask(()=>this.reply({cached:true}));},
      reply(result){this.onmessage({data:{id:this.last.id,type:'result',result}});},terminate(){this.stopped=true;}};
    workers.push(worker);return worker;
  });
  return {...env,workers,pool};
}
const flushBatch=async pool=>{clearTimeout(pool.timer);pool.timer=null;const done=pool.flush();await nextTurn();return {done};};

test('one model handles a real batch and routes out-of-order replies to the correct files', async () => {
  const {pool,workers}=batchEnvironment();
  const id='local-qwen-2b';
  await pool.load(id,4);
  const requests=Array.from({length:4},(_,i)=>pool.generate({model:id,prompt:`File ${i}`,imageDataUrl:i%2?'':'data:image/png;base64,AAAA'}));
  const {done}=await flushBatch(pool);
  assert.equal(workers.length,1);
  assert.equal(workers[0].last.type,'generateBatch');
  assert.equal(workers[0].last.requests.length,4);
  assert.equal(pool.state.phase,'generating');
  workers[0].reply([...workers[0].last.requests].reverse().map(r=>({requestId:r.requestId,text:r.prompt})));
  assert.deepEqual(await Promise.all(requests),['File 0','File 1','File 2','File 3']);
  await done;
  assert.ok(pool.isReady(id));
  pool.cancel();
});

test('cancellation rejects active and queued items and ignores stale batch results', async () => {
  const {pool,workers}=batchEnvironment();
  await pool.load('local-gemma-e2b',2);
  assert.equal(workers.length,1);
  assert.equal(pool.isReady('local-gemma-e2b',2),true);
  const requests=Array.from({length:3},(_,i)=>pool.generate({model:'local-gemma-e2b',prompt:`File ${i}`}));
  const rejections=requests.map(p=>assert.rejects(p,e=>e.name==='AbortError'));
  const {done}=await flushBatch(pool);
  assert.equal(pool.active.length,2);
  assert.equal(pool.queue.length,1);
  assert.throws(()=>pool.unload(), /Stop the local operation/);
  pool.cancel();
  workers[0].reply(workers[0].last.requests.map(r=>({requestId:r.requestId,text:'stale'})));
  await Promise.all(rejections);
  await done;
  assert.ok(workers[0].stopped);
  assert.equal(pool.client,null);
  assert.equal(pool.queue.length,0);
  assert.equal(pool.state.phase,'idle');
});

test('unloading releases the single worker, retains downloaded files, and allows loading again', async () => {
  const env=batchEnvironment(); const {pool,workers}=env;
  const id='local-gemma-e2b';
  const cache=await env.caches.open(env.api.cacheName(id));
  const file='https://test.local/saved-model';
  await cache.put(file,new Response('saved weights'));
  await pool.load(id,2);
  pool.unload();
  assert.equal(pool.client,null);
  assert.equal(pool.state.phase,'idle');
  assert.equal(pool.isReady(id,2),false);
  assert.ok(workers.every(w=>w.stopped));
  assert.equal(await (await cache.match(file)).text(),'saved weights');
  await pool.load(id,1);
  assert.equal(workers.length,2);
  assert.equal(pool.isReady(id,1),true);
  await pool.remove(id);
  assert.equal(workers[1].stopped,true);
  assert.equal(await env.caches.has(env.api.cacheName(id)),false);
});

test('changing batch size never creates another model or reloads weights', async () => {
  const {pool,workers}=batchEnvironment();
  await pool.load('local-gemma-e2b',1);
  pool.setBatchSize(4);
  assert.ok(pool.isReady('local-gemma-e2b',4));
  await pool.load('local-gemma-e2b',20);
  assert.equal(pool.target,20);
  assert.equal(workers.length,1);
  assert.equal(workers[0].messages.length,1);
  assert.equal(workers[0].stopped,undefined);
  pool.cancel();
});

test('partial batches flush without waiting for missing requests; later jobs reuse the same worker', async () => {
  const {pool,workers}=batchEnvironment();const id='local-gemma-e2b';
  await pool.load(id,4);
  const first=pool.generate({model:id,prompt:'One file'});
  // Exercise the actual collection timer, not only explicit flush calls.
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(workers[0].last.requests.length,1);
  const second=pool.generate({model:id,prompt:'Arrives during inference'});
  workers[0].reply([{requestId:workers[0].last.requests[0].requestId,text:'First'}]);
  assert.equal(await first,'First');
  const {done}=await flushBatch(pool);
  workers[0].reply([{requestId:workers[0].last.requests[0].requestId,text:'Second'}]);
  assert.equal(await second,'Second');await done;
  assert.equal(workers.length,1);
  assert.equal(workers[0].messages.filter(m=>m.type==='generateBatch').length,2);
  pool.cancel();
});

test('a bad item does not discard good results; an invalid response envelope fails closed', async () => {
  const {pool,workers}=batchEnvironment();const id='local-qwen-2b';
  await pool.load(id,2);
  const good=pool.generate({model:id,prompt:'Good'});
  const bad=assert.rejects(pool.generate({model:id,prompt:'Bad'}),/thinking limit/);
  let {done}=await flushBatch(pool);
  let requests=workers[0].last.requests;
  workers[0].reply([{requestId:requests[0].requestId,text:'Good'},{requestId:requests[1].requestId,error:'thinking limit'}]);
  assert.equal(await good,'Good');await bad;await done;
  assert.ok(pool.isReady(id));
  const invalid=assert.rejects(pool.generate({model:id,prompt:'No matching id'}),/Invalid local batch response/);
  ({done}=await flushBatch(pool));
  workers[0].reply([{requestId:-1,text:'Wrong file'}]);
  await invalid;await done;
  assert.equal(pool.state.phase,'error');assert.ok(workers[0].stopped);
});

test('worker failure rejects the whole active batch and queued requests without fallback', async () => {
  const {pool,workers}=batchEnvironment();const id='local-qwen-2b';
  await pool.load(id,2);
  const results=Array.from({length:3},()=>assert.rejects(pool.generate({model:id,prompt:'Metadata'}),/worker stopped/));
  const {done}=await flushBatch(pool);
  workers[0].onerror({preventDefault(){}});
  await Promise.all(results);await done;
  assert.equal(pool.queue.length,0);assert.ok(workers[0].stopped);
});
