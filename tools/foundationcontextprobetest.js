import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installFoundationContextProbe} from './foundation-context-probe.js';

function fixture(){
  let now=0,glQueries=0;
  const calls=[],nativeError=new Error('native context failure');
  class Canvas {
    constructor(id=''){
      this.id=id;this.handlers=new Map();
      this.context={getError(){glQueries++;throw Error('Passive probe must not query GL');}};
    }
    getContext(...args){
      assert.ok(this instanceof Canvas,'Native canvas receiver must be preserved');
      calls.push({canvas:this,args});
      if(args[0]==='throw')throw nativeError;
      return args[0]==='unsupported'?null:this.context;
    }
    addEventListener(name,listener){
      let handlers=this.handlers.get(name);if(!handlers)this.handlers.set(name,handlers=new Set());
      handlers.add(listener);
    }
    removeEventListener(name,listener){this.handlers.get(name)?.delete(listener);}
    emit(type,statusMessage=''){
      const event={type,timeStamp:73,statusMessage,prevented:0,preventDefault(){this.prevented++;}};
      for(const listener of this.handlers.get(type)||[])listener(event);
      return event;
    }
    listenerCount(){return [...this.handlers.values()].reduce((count,items)=>count+items.size,0);}
  }
  const native=Canvas.prototype.getContext;
  const descriptor=Object.getOwnPropertyDescriptor(Canvas.prototype,'getContext');
  const host={HTMLCanvasElement:Canvas};
  const sandbox=vm.createContext({window:host,performance:{now:()=>now}});
  const install=()=>vm.runInContext(`(${installFoundationContextProbe.toString()})()`,sandbox);
  install();
  return {Canvas,native,descriptor,host,install,probe:host.__foundationContextProbe,calls,nativeError,
    setTime:value=>{now=value;},glQueries:()=>glQueries};
}

{
  const f=fixture(),canvas=new f.Canvas('early-canvas'),options={alpha:false};
  assert.equal(f.probe.idForCanvas(canvas),null);
  f.setTime(2);
  assert.equal(canvas.getContext('webgl2',options),canvas.context);
  assert.equal(f.probe.idForCanvas(canvas),1);assert.equal(f.probe.idForCanvas(null),null);
  assert.equal(f.calls[0].canvas,canvas);assert.equal(f.calls[0].args[1],options);
  // Emit before any game recovery callback exists: initialization loss must
  // already be observable without changing the event's cancellation state.
  f.setTime(3);const event=canvas.emit('webglcontextlost','driver reset');
  assert.equal(event.prevented,0);
  assert.equal(canvas.getContext('webgl2'),canvas.context);
  assert.equal(canvas.getContext('experimental-webgl'),canvas.context);
  assert.equal(canvas.listenerCount(),2,'Repeated native acquisitions must not add listeners');
  canvas.id='named-later';f.setTime(4);canvas.emit('webglcontextrestored');
  const data=f.probe.snapshot();
  assert.equal(data.installed,true);assert.equal(data.contexts.length,1);
  assert.equal(data.contexts[0].acquiredAtMs,2);assert.equal(data.contexts[0].type,'webgl2');
  assert.equal(data.events.length,2);assert.equal(data.events[0].contextId,1);
  assert.equal(data.events[0].atMs,3);assert.equal(data.events[0].timeStamp,73);
  assert.equal(data.events[0].statusMessage,'driver reset');assert.equal(data.events[0].canvasId,'early-canvas');
  assert.equal(data.events[1].canvasId,'named-later');
  assert.equal(data.lostEvents,1);assert.equal(data.restoredEvents,1);assert.equal(f.glQueries(),0);
  assert.deepEqual(Array.from(data.faults),[]);
  data.events[0].statusMessage='outside';data.contexts[0].lostEvents=999;
  assert.equal(f.probe.snapshot().events[0].statusMessage,'driver reset');
  assert.equal(f.probe.snapshot().contexts[0].lostEvents,1);
  assert.doesNotThrow(()=>JSON.stringify(data));
  const failed=new f.Canvas();assert.equal(failed.getContext('unsupported'),null);
  failed.getContext('2d');assert.equal(failed.listenerCount(),0);
  assert.throws(()=>failed.getContext('throw'),error=>error===f.nativeError);
  assert.equal(f.probe.snapshot().contexts.length,1);
  f.probe.dispose();f.probe.dispose();
  assert.equal(canvas.listenerCount(),0);assert.equal(f.Canvas.prototype.getContext,f.native);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.Canvas.prototype,'getContext'),f.descriptor);
  assert.equal(f.probe.snapshot().disposed,true);assert.equal(f.probe.snapshot().wrapperRestored,true);
  canvas.emit('webglcontextlost');assert.equal(f.probe.snapshot().events.length,2);
  const afterDispose=new f.Canvas();
  assert.equal(afterDispose.getContext('webgl'),afterDispose.context);
  assert.equal(f.probe.idForCanvas(afterDispose),null);assert.equal(f.probe.idForCanvas(canvas),1);
}

{
  const f=fixture(),canvases=[];
  for(let i=0;i<24;i++){
    const canvas=new f.Canvas(`canvas-${i}`);canvases.push(canvas);
    canvas.getContext(i%2?'webgl':'webgl2');canvas.getContext(i%2?'webgl':'webgl2');
  }
  const first=f.probe.snapshot();
  assert.equal(first.contexts.length,16);assert.equal(first.dropped.contexts,8);
  assert.equal(f.probe.idForCanvas(canvases[15]),16);assert.equal(f.probe.idForCanvas(canvases[16]),null);
  assert.equal(canvases[15].listenerCount(),2);assert.equal(canvases[16].listenerCount(),0);
  for(let i=0;i<80;i++)canvases[0].emit(i%2?'webglcontextrestored':'webglcontextlost','x'.repeat(3000));
  const data=f.probe.snapshot();
  assert.equal(data.events.length,64);assert.equal(data.dropped.events,16);
  assert.equal(data.lostEvents,40);assert.equal(data.restoredEvents,40);
  assert.ok(data.events.every(event=>event.statusMessage.length<=2048));assert.equal(f.glQueries(),0);
  f.probe.dispose();assert.ok(canvases.every(canvas=>canvas.listenerCount()===0));
}

{
  const f=fixture(),owned=f.Canvas.prototype.getContext;
  const later=function(...args){return owned.apply(this,args);};
  f.Canvas.prototype.getContext=later;
  f.probe.dispose();assert.equal(f.Canvas.prototype.getContext,later,'Do not overwrite a later owner');
  const canvas=new f.Canvas();canvas.getContext('webgl');
  assert.equal(canvas.listenerCount(),0,'A retained wrapper must become passive after dispose');
  assert.equal(f.probe.snapshot().contexts.length,0);
  f.install();const next=f.host.__foundationContextProbe;
  assert.notEqual(next,f.probe);canvas.getContext('webgl2');assert.equal(canvas.listenerCount(),2);
  next.dispose();assert.equal(canvas.listenerCount(),0);assert.equal(f.Canvas.prototype.getContext,later);
  assert.equal(f.glQueries(),0);
}

console.log('PASS serialized early context probe: native semantics, initialization loss, no GL queries/cancellation, bounded listeners/events and ownership-aware restoration.');
