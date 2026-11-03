import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmassHybridBackend,passageSpan } from "../../src/search-providers/anserini/cmass_hybrid_backend";

const a="shard_00000_0",b="shard_00000_1",c="shard_00000_2";
const repeated=Array(250).fill("repeat😀longword").join("\t");
const sources:Record<string,string>={[a]:repeated+"\n\n"+repeated+"\u0085"+"tail",[b]:"short other document",[c]:"short passage-only candidate"};
const counts={doc:0,passage:0,lengths:0};
const server=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||"{}");let value:any;
  if(req.url==="/document/search") {counts.doc++;value={results:[{docid:a,score:10,length_utf16:sources[a].length},{docid:b,score:5,length_utf16:sources[b].length}],elapsed_ms:1};}
  else if(req.url==="/passage/search") {counts.passage++;value={results:[{docid:`cmasspass_${c}_0`,score:20},{docid:`cmasspass_${a}_1`,score:10},{docid:`cmasspass_${a}_0`,score:9}],elapsed_ms:2};}
  else if(req.url==="/document/lengths") {counts.lengths++;value={lengths:Object.fromEntries(body.docids.map((id:string)=>[id,sources[id].length]))};}
  else if(req.url==="/document/doc") value={found:true,docid:body.docid,text:sources[body.docid]};
  else throw new Error("Unexpected URL "+req.url);
  res.setHeader("content-type","application/json");res.end(JSON.stringify(value));
});
await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
const port=(server.address() as any).port;
const dir=mkdtempSync(join(tmpdir(),"cmass-hybrid-test-"));const events:any[]=[];
try {
  const backend=createCmassHybridBackend({CMASS_HYBRID_DOCUMENT_URL:`http://127.0.0.1:${port}/document`,CMASS_HYBRID_PASSAGE_URL:`http://127.0.0.1:${port}/passage`,JEV_FIND_LOG:join(dir,"jev-find.jsonl")},row=>events.push(row));
  const result=await backend.search({query:"test",limit:1000});
  assert.deepEqual(result.hits.map(r=>r.docid),[a+"#1",a+"#0",c,b]);
  assert.deepEqual(result.hits.map(r=>r.score),[.5,.5,.5,0]);
  assert.deepEqual(counts,{doc:1,passage:1,lengths:1});
  const read=await backend.readDocument({docid:a+"#1",offset:1,limit:200});assert.ok(read.found);
  const mapping=backend.getUnitMapping(a+"#1")!;
  assert.equal(mapping.pieces[0].doc[0],repeated.length+2);
  assert.equal(mapping.text,repeated);
  assert.equal(read.text,repeated);
  assert.equal(mapping.docText.slice(...mapping.pieces[0].doc),mapping.text);
  assert.equal((await backend.readDocument({docid:c,offset:1,limit:200}) as any).text,sources[c]);
  assert.deepEqual(passageSpan("a\u0085b\u001cc\u00a0😀",0),[0,8]);
  assert.throws(()=>passageSpan("word",1));
  const files=readdirSync(join(dir,"hybrid-source-cache"));assert.equal(files.length,3);
  for(const f of files){const r=JSON.parse(readFileSync(join(dir,"hybrid-source-cache",f),"utf8"));assert.equal(r.text,sources[r.docid]);}
  assert.ok(events.some(e=>e.type==="passage_unit_aligned"&&e.exact));
  await backend.close?.();
  console.log(JSON.stringify({passed:true,checks:["original convex fusion","two ranked passages for long doc","short passage-only candidate length","zero-based repeated passage exact UTF16 coordinates","Unicode whitespace","immutable source audit cache"],model_calls:0}));
} finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
