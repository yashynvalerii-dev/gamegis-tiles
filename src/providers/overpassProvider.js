/**
 * Stage 8: one fixed, cautious Overpass read-only adapter.
 * Offline by default. A trusted future Stage9 integration must inject network
 * transport and explicitly opt in AFTER policy approval/reservation.
 * This module makes no network requests on import or construction.
 */
import { normalizeOsmMvpBase, DATASET_ID, NORMALIZATION_VERSION, PROCESSED_LAYERS } from '../gis/normalizer.js';
import {validateTile, expandedTileBounds, bboxContainsBbox} from '../core/tileGrid.js';

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MAX_BYTES=8_000_000;
const SELECTORS = Object.freeze([
  '["highway"~"^(footway|path|pedestrian|living_street|track|steps)$"]',
  '["building"]', '["natural"="water"]', '["water"]',
  '["waterway"="riverbank"]', '["landuse"~"^(industrial|military|reservoir)$"]',
  '["railway"]', '["military"]',
  '["access"~"^(private|no|customers|permit)$"]',
  '["foot"~"^(private|no)$"]',
]);
const f7 = n => (Math.round(n*1e7)/1e7).toFixed(7);
function outwardScope(tile,bufferM){
  const b=expandedTileBounds(tile,bufferM);
  const south=Math.floor(b.south*1e7)/1e7, west=Math.floor(b.west*1e7)/1e7;
  const north=Math.ceil(b.north*1e7)/1e7, east=Math.ceil(b.east*1e7)/1e7;
  const scope={south,north,west,east};
  if(!bboxContainsBbox(scope,b)) throw new Error('QUERY_BBOX_NOT_CONTAINING_BUFFER');
  return scope;
}
export function buildOverpassQuery({tile,bufferM=40,timeoutSec=25}={}){
  const t=validateTile(tile);
  if(!Number.isInteger(bufferM)||bufferM<30||bufferM>1000)throw new RangeError('bufferM must be integer 30..1000');
  if(!Number.isInteger(timeoutSec)||timeoutSec<1||timeoutSec>25)throw new RangeError('timeoutSec must be 1..25');
  const bbox=outwardScope(t,bufferM);
  const coords=[bbox.south,bbox.west,bbox.north,bbox.east].map(f7).join(',');
  const clauses=['node["entrance"]'];
  for(const kind of ['way','relation']) for(const selector of SELECTORS)clauses.push(kind+selector);
  const query=`[out:json][timeout:${timeoutSec}];(\n${clauses.map(x=>`  ${x}(${coords});`).join('\n')}\n);out body geom;`;
  return {query,bbox,tile:t,bufferM,timeoutSec,datasetId:DATASET_ID,normalizationVersion:NORMALIZATION_VERSION};
}
function safeRetryAfter(value,now){
  if(typeof value!=='string'||!value.trim())return undefined;
  const v=value.trim();let secs;
  if(/^\d{1,8}$/.test(v))secs=Number(v);
  else {const parsed=Date.parse(v);if(Number.isFinite(parsed))secs=Math.max(0,Math.ceil((parsed-now)/1000));}
  return Number.isSafeInteger(secs)&&secs>=0&&secs<=365*86400?secs:undefined;
}
function errorResult(reason,actualBytes,extras={}){return {outcome:'ERROR',actualBytes,reason,...extras};}

/**
 * fetchImpl is REQUIRED and must be injected; never implicitly uses global fetch.
 * networkApproved must be explicitly true to invoke even the injected transport.
 * A caller must have already obtained a durable Stage6 policy reservation.
 */
export function createOverpassProvider({fetchImpl,contact,networkApproved=false,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(typeof fetchImpl!=='function'||typeof clock!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function')
    throw new TypeError('Trusted fetchImpl, clock and timers are required');
  if(typeof contact!=='string'||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))||contact.length>150)
    throw new TypeError('Explicit contact email required for network identification');
  if(typeof networkApproved!=='boolean')throw new TypeError('networkApproved must be boolean');
  async function execute({tile,bufferM=40,maxResponseBytes,deadlineAtMs,signal}={}){
    if(!networkApproved)throw new Error('NETWORK_DISABLED_UNTIL_OWNER_APPROVAL');
    if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>MAX_BYTES)
      throw new RangeError('Invalid reserved maxResponseBytes 1..8000000');
    const now=clock();
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(deadlineAtMs)||deadlineAtMs<=now)
      return errorResult('DEADLINE_EXPIRED_BEFORE_NETWORK',0,{outcome:'TIMEOUT'});
    if(signal!==undefined && (typeof signal!=='object'||typeof signal.addEventListener!=='function'))throw new TypeError('Invalid AbortSignal');
    if(signal?.aborted)return errorResult('CANCELLED_BEFORE_NETWORK',0,{outcome:'TIMEOUT'});
    const timeoutMs=Math.min(25000,deadlineAtMs-now);
    const scope=buildOverpassQuery({tile,bufferM,timeoutSec:Math.max(1,Math.min(25,Math.ceil(timeoutMs/1000)))});
    const ctrl=new AbortController();
    const relay=()=>ctrl.abort(signal?.reason);
    signal?.addEventListener('abort',relay,{once:true});
    if(signal?.aborted)ctrl.abort(signal.reason);
    const timer=setTimer(()=>ctrl.abort(new Error('OVERPASS_TIMEOUT')),timeoutMs);
    let reader=null,received=0,completedStream=false;
    try{
      if(ctrl.signal.aborted)return errorResult('ABORTED_BEFORE_NETWORK',0,{outcome:'TIMEOUT'});
      const response=await fetchImpl(OVERPASS_ENDPOINT,{
        method:'POST',body:new URLSearchParams({data:scope.query}).toString(),
        headers:{'content-type':'application/x-www-form-urlencoded; charset=utf-8',
          'accept':'application/json', 'user-agent':`GameGIS-Broker/0.1 (${contact})`},
        redirect:'error',cache:'no-store',signal:ctrl.signal,
      });
      if(!response||!Number.isInteger(response.status)||typeof response.headers?.get!=='function')
        return errorResult('INVALID_RESPONSE',maxResponseBytes);
      const lengthText=response.headers.get('content-length');
      if(lengthText!==null && /^\d+$/.test(lengthText) && Number(lengthText)>maxResponseBytes)
        return errorResult('RESPONSE_LENGTH_EXCEEDS_RESERVATION',maxResponseBytes);
      const parts=[];
      if(response.body){
        if(typeof response.body.getReader!=='function')return errorResult('INVALID_RESPONSE_STREAM',maxResponseBytes);
        reader=response.body.getReader();
        while(true){
          const part=await reader.read();
          if(part.done){completedStream=true;break;}
          if(!(part.value instanceof Uint8Array))return errorResult('INVALID_RESPONSE_CHUNK',maxResponseBytes);
          received+=part.value.byteLength;
          if(received>maxResponseBytes){await reader.cancel().catch(()=>{});return errorResult('RESPONSE_BYTE_LIMIT_EXCEEDED',received);}
          parts.push(part.value);
        }
      } else completedStream=true;
      const bytes=Buffer.concat(parts.map(v=>Buffer.from(v)),received);
      const after=clock();
      const retryAfter=safeRetryAfter(response.headers.get('retry-after'),after);
      if(response.status!==200){
        const outcome=response.status===429?'HTTP_429':response.status===503?'HTTP_503':response.status===504?'TIMEOUT':'ERROR';
        return {outcome,actualBytes:received,reason:`HTTP_${response.status}`,
          ...(retryAfter===undefined?{}:{retryAfterSec:retryAfter})};
      }
      if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))
        return errorResult('RESPONSE_NOT_JSON',received);
      let payload;
      try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return errorResult('INVALID_UTF8_OR_JSON',received);}
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.elements)||
        payload.remark!==undefined||payload.error!==undefined)
        return errorResult('INCOMPLETE_OR_INVALID_OSM_RESPONSE',received);
      let normalized;
      try{normalized=normalizeOsmMvpBase(payload,{provider:'OVERPASS'});}
      catch{return errorResult('OSM_NORMALIZATION_INVALID',received);}
      if(!normalized.diagnostics.complete ||
        JSON.stringify([...normalized.diagnostics.processedLayers].sort())!==JSON.stringify([...PROCESSED_LAYERS].sort()))
        return errorResult('OSM_NORMALIZATION_INCOMPLETE',received);
      if(after>deadlineAtMs||ctrl.signal.aborted)return errorResult('DEADLINE_EXPIRED_AFTER_RESPONSE',received,{outcome:'TIMEOUT'});
      return {outcome:'SUCCESS',actualBytes:received,rawBytes:bytes,rawPayload:payload,
        fetchedAt:new Date(after).toISOString(),verifiedQueryScope:{
          ...scope,provider:'OVERPASS',normalizationComplete:true,
          layers:[...PROCESSED_LAYERS], certifiedReady:false,
        }};
    }catch(e){
      // A stream abandoned before EOF has UNKNOWN eventual byte usage. Fail closed:
      // charge full reserved budget via the future Stage6 completion operation.
      return errorResult(ctrl.signal.aborted?'NETWORK_ABORTED_OR_TIMEOUT':'NETWORK_TRANSPORT_ERROR',maxResponseBytes,
        {outcome:ctrl.signal.aborted?'TIMEOUT':'ERROR'});
    }finally{
      clearTimer(timer);signal?.removeEventListener('abort',relay);
      if(reader){try{reader.releaseLock();}catch{}}
    }
  }
  return Object.freeze({execute});
}
