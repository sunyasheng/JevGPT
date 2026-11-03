import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJevAnswerV2 } from "../src/extensions/pi_search_jev_hybrid_v2";
import { SearchSessionStore } from "../src/pi-search/search_cache";

// CMASS hybrid (PI_SEARCH_QUESTION_LIFETIME=1) against the paper runtime's 32-search limit, through the actual tools.
test("question lifetime: actual CMASS tools, deep offsets, boundaries and delayed results", async () => {
  const dir=mkdtempSync(join(tmpdir(),"cmass-life-"));
  const ids=Array.from({length:200},(_,i)=>`shard_00000_${i}`);
  const source=(id:string)=>`Evidence marker ${id} is blue.`;
  let releaseSearch:(()=>void)|undefined, searchEntered:(()=>void)|undefined;
  let releaseJev:(()=>void)|undefined, jevEntered:(()=>void)|undefined;
  let delayedJev=false;
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw||"{}");let result:any;
    if(req.url==="/document/search") {
      if(b.query==="late") {searchEntered?.();await new Promise<void>(r=>releaseSearch=r);}
      result={results:ids.map((docid,i)=>({docid,score:200-i,length_utf16:source(docid).length})),elapsed_ms:1};
    } else if(req.url==="/passage/search")result={results:[],elapsed_ms:1};
    else if(req.url==="/document/lengths")result={lengths:Object.fromEntries(b.docids.map((id:string)=>[id,source(id).length]))};
    else if(req.url==="/document/doc")result={found:true,docid:b.docid,text:source(b.docid)};
    else if(req.url==="/jev") {
      if(delayedJev){delayedJev=false;jevEntered?.();await new Promise<void>(r=>releaseJev=r);}
      result={model:"jev-1.13.0",usage:{input_tokens:10,output_tokens:2},answers:Object.fromEntries(Object.entries(b.questions).map(([k,v]:[string,any])=>{
        const choices=Object.keys(v.criteria);const choice=choices.includes("ANSWERED")?"ANSWERED":choices.includes("ADVANCE")?"ADVANCE":choices[0];
        return [k,v.type==="noul"?{type:"noul",noul:k==="discovery"?0:1}:{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(choices.map(c=>[c,c===choice?1:0]))}];
      }))};
    } else throw new Error("Unexpected endpoint "+req.url);
    res.setHeader("content-type","application/json");res.end(JSON.stringify(result));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address()as any).port;
  const env={...process.env};Object.assign(process.env,{CMASS_HYBRID:"1",CMASS_HYBRID_DOCUMENT_URL:`http://127.0.0.1:${port}/document`,CMASS_HYBRID_PASSAGE_URL:`http://127.0.0.1:${port}/passage`,JEV_URL:`http://127.0.0.1:${port}/jev`,JEV_AUTOSCAN:"0",JEV_BATCH_SIZE:"60",TYPESAFE_API_KEY:"offline-fixture",JEV_FIND_LOG:join(dir,"jev.jsonl"),PI_SEARCH_EXTENSION_CONFIG:JSON.stringify({backend:{kind:"mock",documents:[]}})});
  function harness(lifetime:boolean){
    const tools=new Map<string,any>(),hooks=new Map<string,any[]>();
    const pi:any={registerTool:(t:any)=>tools.set(t.name,t),on:(n:string,f:any)=>hooks.set(n,[...(hooks.get(n)??[]),f]),getActiveTools:()=>[...tools.keys()],setActiveTools:()=>{},sendUserMessage:()=>{}};
    if(lifetime)process.env.PI_SEARCH_QUESTION_LIFETIME="1";
    try {registerJevAnswerV2(pi,"hybrid");} finally {delete process.env.PI_SEARCH_QUESTION_LIFETIME;}
    return {tools, async emit(n:string,event:any={}){const values=[];for(const f of hooks.get(n)??[])values.push(await f(event,{cwd:dir,isIdle:()=>true}));return values;},async call(n:string,args:any){return tools.get(n).execute("fixture",args,undefined,undefined,{cwd:dir});}};
  }
  const newer=harness(true),older=harness(false);
  try {
    for(const h of[newer,older]){await h.emit("session_start");await h.emit("input",{text:"Task\nQuestion: Identify the blue marker."});}
    assert.deepEqual(await newer.emit("before_agent_start",{systemPrompt:"Fixture system",prompt:"Fixture question"}),await older.emit("before_agent_start",{systemPrompt:"Fixture system",prompt:"Fixture question"}));
    for(let i=1;i<=35;i++){
      const a=await newer.call("search",{reason:"fixture",query:"marker"}),b=await older.call("search",{reason:"fixture",query:"marker"});
      assert.deepEqual(a.content,b.content);assert.deepEqual(a.details.retrievedDocids,b.details.retrievedDocids);assert.equal(a.details.searchId,`s${i}`);
    }
    // The paper limit expires s2 after 35 searches; question lifetime keeps it.
    for(const offset of[61,121]){
      await assert.rejects(older.call("jev_find",{reason:"deep",search_id:"s2",offset,queries:["What is the marker?"]}),/Unknown or expired/);
      await assert.rejects(older.call("read_search_results",{reason:"deep",search_id:"s2",offset}),/unknown/);
      const page=await newer.call("read_search_results",{reason:"deep",search_id:"s2",offset,limit:10});assert.equal(page.details.returnedRankStart,offset);
      const found=JSON.parse((await newer.call("jev_find",{reason:"deep",search_id:"s2",offset,queries:["What is the marker?"]})).content[0].text);
      assert.equal(found.ranking.start,offset);assert.equal(found.documents[0].docid,ids[offset-1]);assert.ok(found.documents[0].passages.some((p:any)=>p.text.includes(source(ids[offset-1]))));
    }
    const events=readFileSync(join(dir,"jev.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
    for(const offset of[61,121])assert.deepEqual(events.find(e=>e.type==="batch_selection"&&e.params.search_id==="s2"&&e.params.offset===offset).resolved_docids,ids.slice(offset-1,offset-1+60));
    // Agent end / compaction / continued turns do not end a question.
    await newer.emit("agent_end");await newer.emit("session_compact");await newer.emit("input",{text:"Continue checking evidence."});await newer.emit("agent_start");
    assert.equal((await newer.call("read_search_results",{reason:"continue",search_id:"s2",offset:121})).details.returnedRankStart,121);
    // No replacement finite threshold: retain early IDs after1000searches.
    for(let i=36;i<=1000;i++)await newer.call("search",{reason:"fixture",query:"marker"});
    assert.equal((await newer.call("read_search_results",{reason:"deep",search_id:"s2",offset:121})).details.returnedRankStart,121);
    const entered=new Promise<void>(r=>searchEntered=r);const late=newer.call("search",{reason:"late",query:"late"});const rejected=assert.rejects(late,/ended question/);await entered;
    await newer.emit("input",{text:"Task\nQuestion: Next question."});releaseSearch!();await rejected;
    await assert.rejects(newer.call("read_search_results",{reason:"old",search_id:"s2",offset:61}),/unknown/);
    await assert.rejects(newer.call("jev_find",{reason:"old",search_id:"s2",offset:61,queries:["marker"]}),/Unknown or expired/);
    const fresh=await newer.call("search",{reason:"fresh",query:"marker"});assert.equal(fresh.details.searchId,"s1001");
    // A delayed old Jev result also cannot restore its ranking/seen evidence into nextquestion.
    delayedJev=true;const jentered=new Promise<void>(r=>jevEntered=r);const jlate=newer.call("jev_find",{reason:"late",search_id:"s1001",queries:["marker"]});const jreject=assert.rejects(jlate,/ended question/);await jentered;
    await newer.emit("input",{text:"Task\nQuestion: Third question."});releaseJev!();await jreject;
    await assert.rejects(newer.call("read_document",{reason:"old",docid:ids[0]}),/First use jev_find/);
    await newer.emit("session_shutdown");await assert.rejects(newer.call("search",{reason:"ended",query:"marker"}),/ended question/);
    // Ignore cancellation in the fixture transport to force a genuinely late auto-scan callback.
    const originalFetch=globalThis.fetch;
    globalThis.fetch=((input:any,init:any)=>originalFetch(input,String(input).endsWith("/jev")?{...init,signal:undefined}:init))as typeof fetch;
    process.env.JEV_AUTOSCAN="1";
    const auto=harness(true);process.env.JEV_AUTOSCAN="0";
    try {
      await auto.emit("session_start");await auto.emit("input",{text:"Task\nQuestion: Marker is blue. Which marker?"});
      delayedJev=true;const scanEntered=new Promise<void>(r=>jevEntered=r);
      await auto.call("search",{reason:"auto",query:"marker"});await scanEntered;
      await auto.emit("input",{text:"Task\nQuestion: Different question."});releaseJev!();
      // All fixture requests complete quickly; wait for the captured old scan to settle.
      await new Promise(r=>setTimeout(r,150));
      await assert.rejects(auto.call("read_document",{reason:"oldscan",docid:ids[0]}),/First use jev_find/);
      await assert.rejects(auto.call("jev_find",{reason:"oldscan",search_id:"s1",queries:["marker"]}),/Unknown or expired/);
      const freshAuto=await auto.call("search",{reason:"new",query:"marker"});assert.equal(freshAuto.details.searchId,"s2");
    } finally {await auto.emit("session_shutdown");globalThis.fetch=originalFetch;}
    const store=new SearchSessionStore();store.createSearch("q","plain",[]);store.endQuestion();assert.equal(store.getSearch("s1"),undefined);store.beginQuestion();assert.equal(store.createSearch("next","plain",[]).searchId,"s2");assert.equal(store.getSearch("s1"),undefined);
  } finally {
    await newer.emit("session_shutdown");await older.emit("session_shutdown");for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);await new Promise<void>(r=>server.close(()=>r()));
  }
});
