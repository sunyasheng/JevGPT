/** CMASS hybrid BM25: full-corpus document and passage services (services/cmass_hybrid) fused as in the paper's hybrid runs. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiSearchBackend } from "../../pi-search/searcher/contract/interface";
import type { SearchBackendReadDocumentRequest, SearchBackendReadDocumentResponse } from "../../pi-search/searcher/contract/types";
import { HybridBm25Backend } from "../../pi-search/searcher/adapters/passage_bm25/hybrid";
import { PassageBm25Backend, parseUnitId, parsePassageId, sliceLines, type UnitMapping, type PassageHelperTransport } from "../../pi-search/searcher/adapters/passage_bm25/adapter";

const PREFIX="cmasspass_";
// Same explicit Unicode whitespace as the frozen Java index generator and Python sizing probe.
const WORDS=/[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export function passageSpan(text:string,index:number):[number,number] {
  if(!Number.isSafeInteger(index)||index<0) throw new Error("Invalid passage index");
  let n=0,start=-1,end=-1;
  for(const m of text.matchAll(WORDS)) {
    if(n===index*250) start=m.index!;
    if(n>=index*250 && n<(index+1)*250) end=m.index!+m[0].length;
    n++;if(n===(index+1)*250) break;
  }
  if(start<0||end<start) throw new Error("Passage absent from immutable parent");
  return [start,end];
}
function page(docid:string,text:string,request:SearchBackendReadDocumentRequest):SearchBackendReadDocumentResponse {
  return {found:true,docid,...sliceLines(text,request.offset??1,request.limit??200)};
}
export function createCmassHybridBackend(env:NodeJS.ProcessEnv, audit?:(row:Record<string,unknown>)=>void):HybridBm25Backend {
  const docURL=env.CMASS_HYBRID_DOCUMENT_URL,passURL=env.CMASS_HYBRID_PASSAGE_URL;
  if(!docURL||!passURL||!env.JEV_FIND_LOG) throw new Error("Missing isolated CMASS hybrid endpoints/audit path");
  const sourceDir=join(dirname(env.JEV_FIND_LOG),"hybrid-source-cache");mkdirSync(sourceDir,{recursive:true});
  const lengths=new Map<string,number>(),texts=new Map<string,string>(),inflight=new Map<string,Promise<string>>();
  let cachedChars=0;
  async function post(url:string,body:unknown,signal?:AbortSignal):Promise<any> {
    const started=performance.now();const encoded=JSON.stringify(body);
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:encoded,signal});
    const raw=await response.text();
    audit?.({type:"cmass_hybrid_backend_request",url,request:body,response_sha256:hash(raw),status:response.status,elapsed_ms:performance.now()-started});
    if(!response.ok) throw new Error(`Hybrid backend HTTP ${response.status}: ${raw.slice(0,250)}`);
    return JSON.parse(raw);
  }
  async function source(docid:string,signal?:AbortSignal):Promise<string> {
    if(!/^shard_\d{5}_\d+$/.test(docid)) throw new Error("Invalid parent document id");
    if(texts.has(docid)) return texts.get(docid)!;
    if(inflight.has(docid)) return inflight.get(docid)!;
    const task=(async()=>{
      const r=await post(docURL+"/doc",{docid},signal);
      if(!r.found||r.docid!==docid||typeof r.text!=="string") throw new Error("Missing immutable source");
      lengths.set(docid,r.text.length);
      const p=join(sourceDir,hash(docid)+".json");const sha=hash(r.text);
      if(existsSync(p)) {if(JSON.parse(readFileSync(p,"utf8")).sha256!==sha) throw new Error("Source changed");}
      else writeFileSync(p,JSON.stringify({docid,text:r.text,sha256:sha}),{flag:"wx",mode:0o600});
      while(texts.size && (texts.size>=32||cachedChars+r.text.length>40_000_000)) {
        const oldest=texts.keys().next().value!;cachedChars-=texts.get(oldest)!.length;texts.delete(oldest);
      }
      texts.set(docid,r.text);cachedChars+=r.text.length;return r.text as string;
    })().finally(()=>inflight.delete(docid));
    inflight.set(docid,task);return task;
  }
  let lastKey="",lastRanking:Promise<{doc:any;passage:any}>|undefined;
  function ranking(query:string,k:number,signal?:AbortSignal) {
    const key=JSON.stringify([query,k]);
    if(lastRanking&&lastKey===key) return lastRanking;
    lastKey=key;
    lastRanking=(async()=>{
      const [doc,passage]=await Promise.all([post(docURL+"/search",{query,k},signal),post(passURL+"/search",{query,k},signal)]);
      for(const r of doc.results) {if(!Number.isSafeInteger(r.length_utf16)) throw new Error("Missing length");lengths.set(r.docid,r.length_utf16);}
      const missing=[...new Set<string>(passage.results.map((r:any)=>{
        const unit=parsePassageId(PREFIX,r.docid);if(!unit) throw new Error("Invalid passage ID");return unit.docid;
      }))].filter(id=>!lengths.has(id));
      if(missing.length) {
        const extra=await post(docURL+"/lengths",{docids:missing},signal);
        for(const id of missing) {if(!Number.isSafeInteger(extra.lengths[id])) throw new Error("Missing passage parent length");lengths.set(id,extra.lengths[id]);}
      }
      return {doc,passage};
    })().catch(e=>{lastRanking=undefined;throw e;});
    return lastRanking;
  }
  async function passageText(id:string,signal?:AbortSignal) {
    const u=parsePassageId(PREFIX,id);if(!u) throw new Error("Invalid passage ID");
    const text=await source(u.docid,signal),[a,b]=passageSpan(text,u.index);
    return [...text.slice(a,b).matchAll(WORDS)].map(m=>m[0]).join(" ");
  }
  function helper(side:"doc"|"passage"):PassageHelperTransport {
    return {async request(command,params,signal) {
      if(command==="search") {
        const pair=await ranking(String(params.query),Number(params.k),signal),r=pair[side];
        return JSON.stringify({results:r.results,timing_ms:{command:r.elapsed_ms}});
      }
      if(command==="read_document") {
        const id=String(params.docid),text=side==="doc"?await source(id,signal):await passageText(id,signal);
        return JSON.stringify({found:true,docid:id,text,truncated:false,total_lines:text.split("\n").length});
      }
      if(command==="render_search_results") {
        const rows=[];
        for(const id of params.docids as string[]) {
          const text=side==="doc"?await source(id,signal):await passageText(id,signal);
          const normalized=[...text.matchAll(WORDS)].map(m=>m[0]).join(" ");
          const cap=Number(params.snippet_max_chars??220);
          rows.push({docid:id,excerpt:normalized.slice(0,cap),excerpt_truncated:normalized.length>cap});
        }
        return JSON.stringify({results:rows});
      }
      throw new Error("Unsupported hybrid operation: "+command);
    }};
  }
  const documentHelper=helper("doc"),passages=helper("passage");
  const documents:PiSearchBackend={
    capabilities:{backendId:"cmass-document-bm25-25-1",supportsScore:true,supportsSnippets:true,supportsExactTotalHits:false,maxPageSize:1000},
    async search(r,signal){const data=await ranking(r.query,r.limit,signal);return {hits:data.doc.results,hasMore:data.doc.results.length>=r.limit};},
    async readDocument(r,signal){return page(r.docid,await source(r.docid,signal),r);},
  };
  class ExactUnits extends PassageBm25Backend {
    private readonly exact=new Map<string,UnitMapping>();
    override getUnitMapping(id:string){return this.exact.get(id);}
    override async titleOf(_id:string,_signal?:AbortSignal){return undefined;}
    override async readDocument(r:SearchBackendReadDocumentRequest,signal?:AbortSignal):Promise<SearchBackendReadDocumentResponse> {
      const u=parseUnitId(r.docid);if(!u)return documents.readDocument(r,signal);
      let mapping=this.exact.get(r.docid);
      if(!mapping) {
        const parent=await source(u.docid,signal),[a,b]=passageSpan(parent,u.index),text=parent.slice(a,b);
        mapping={unitId:r.docid,docid:u.docid,index:u.index,aligned:true,text,pieces:[{local:[0,text.length],doc:[a,b]}],docLength:parent.length,docText:parent};
        this.exact.set(r.docid,mapping);
        audit?.({type:"passage_unit_aligned",unit:r.docid,span:[a,b],pieces:mapping.pieces,exact:true,method:"deterministic_250_word_offsets",parent_sha256:hash(parent)});
      }
      return {...page(r.docid,mapping.text,r),metadata:{passage_unit:r.docid,parent_docid:u.docid,passage_index:u.index,aligned:true,pieces:mapping.pieces,doc_length_utf16:mapping.docLength}} as SearchBackendReadDocumentResponse;
    }
  }
  const units=new ExactUnits({passages,documents,passageIdPrefix:PREFIX,observe:audit});
  const hybrid=new HybridBm25Backend({passages,documentHelper,documents,units,docLengths:lengths,
    shortChars:8000,fusion:"cc",lambda:.5,passagesPerDoc:2,passageIdPrefix:PREFIX,previewWindow:50});
  const backendLog=join(dirname(env.JEV_FIND_LOG),"backend-requests.jsonl");
  const search=hybrid.search.bind(hybrid),read=hybrid.readDocument.bind(hybrid);
  hybrid.search=async(r,signal)=>{
    const start=performance.now(),result=await search(r,signal);
    appendFileSync(backendLog,JSON.stringify({operation:"search",request:r,elapsed_ms:performance.now()-start,
      docids:result.hits.map(h=>parseUnitId(h.docid)?.docid??h.docid),unit_ids:result.hits.map(h=>h.docid),
      result_sha256:hash(JSON.stringify(result))})+"\n",{mode:0o600});
    return result;
  };
  hybrid.readDocument=async(r,signal)=>{
    const start=performance.now(),result=await read(r,signal);
    appendFileSync(backendLog,JSON.stringify({operation:"readDocument",request:{...r,docid:parseUnitId(r.docid)?.docid??r.docid},unit_id:r.docid,
      found:result.found,elapsed_ms:performance.now()-start,result_sha256:hash(JSON.stringify(result))})+"\n",{mode:0o600});
    return result;
  };
  return hybrid;
}
