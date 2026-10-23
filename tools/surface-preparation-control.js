// Pure classification of the preparation transcript. Missing observations in
// an old report remain unobserved; program creation never implies selection.
const identity=(a,b)=>Boolean(a&&b&&a.id===b.id&&a.nativeId===b.nativeId);
const sourcesFor=(program,sources)=>program&&typeof sources?.[program.vertexSha256]==='string'
  &&typeof sources?.[program.fragmentSha256]==='string';
const sameProgram=(a,b,aSources,bSources=aSources)=>identity(a,b)&&a.cacheKey===b.cacheKey
  &&a.vertexSha256===b.vertexSha256&&a.fragmentSha256===b.fragmentSha256
  &&sourcesFor(a,aSources)&&sourcesFor(b,bSources)
  &&aSources[a.vertexSha256]===bSources[b.vertexSha256]&&aSources[a.fragmentSha256]===bSources[b.fragmentSha256];
const sameSource=(a,b,aSources,bSources)=>Boolean(a&&b&&a.cacheKey===b.cacheKey
  &&a.vertexSha256===b.vertexSha256&&a.fragmentSha256===b.fragmentSha256
  &&sourcesFor(a,aSources)&&sourcesFor(b,bSources)
  &&aSources[a.vertexSha256]===bSources[b.vertexSha256]&&aSources[a.fragmentSha256]===bSources[b.fragmentSha256]);
const rows=value=>Array.isArray(value)?value:[];
const added=(before,after)=>rows(after).filter(program=>!rows(before).some(previous=>previous.id===program.id));
const retains=(before,after,sources)=>rows(before).every(program=>rows(after).some(next=>sameProgram(program,next,sources)));
const sameSet=(before,after,sources)=>rows(before).length===rows(after).length&&retains(before,after,sources)&&retains(after,before,sources);
const exactReplace=(text,before,after)=>typeof text==='string'&&text.includes(before)
  &&text.indexOf(before)===text.lastIndexOf(before)?text.replace(before,after):null;
function prefixSwap(before,after,union) {
  if(typeof before!=='string'||typeof after!=='string')return false;
  const screen='#define SURFACE_CLOUD_SCREEN 1',stellar=`#define STELLAR_UNION_OCCLUSION ${union}`;
  const selectors=before.split('\n').filter(line=>/^#define (?:SURFACE_CLOUD_SCREEN|STELLAR_UNION_OCCLUSION)\b/.test(line));
  const shaderName=before.indexOf('\n#define SHADER_NAME '),uniform=before.indexOf('\nuniform '),location=before.indexOf(`\n${screen}\n${stellar}\n`);
  // Restrict the one permitted edit to Three's generated prefix. The complete
  // remaining source must match, including all unrelated defines and GLSL.
  return selectors.length===2&&selectors[0]===screen&&selectors[1]===stellar
    &&shaderName>=0&&uniform>shaderName&&location>shaderName&&location<uniform
    &&exactReplace(before,`${screen}\n${stellar}\n`,`${stellar}\n${screen}\n`)===after;
}
function validSet(programs,sources) {
  if(!Array.isArray(programs)||!programs.length)return false;
  return new Set(programs.map(p=>p.id)).size===programs.length&&new Set(programs.map(p=>p.nativeId)).size===programs.length
    &&new Set(programs.map(p=>p.cacheKey)).size===programs.length&&programs.every(p=>Number.isInteger(p.id)&&p.id>=0
      &&Number.isInteger(p.nativeId)&&p.nativeId>0&&typeof p.cacheKey==='string'&&p.linkStatus===true&&sourcesFor(p,sources));
}
const selected=(programs,id,nativeId)=>rows(programs).find(program=>program.id===id&&program.nativeId===nativeId);
const validBits=value=>Array.isArray(value)&&value.length===32*32*4&&value.every(bits=>Number.isInteger(bits)&&bits>=0&&bits<=65535);
const equalBits=(a,b)=>validBits(a)&&validBits(b)&&a.every((bits,i)=>bits===b[i]);

export function classifySurfacePreparationPair({reference,candidate,referenceSources={},candidateSources={}},{legacy=false}={}) {
  const checks=[];
  const check=(name,passed)=>checks.push({name,status:passed?'pass':'fail',passed:Boolean(passed)});
  const observed=(name,available,work)=>{
    if(!available&&legacy)checks.push({name,status:'unobserved',passed:null});
    else check(name,available&&work());
  };
  const union=Number(reference?.blockerCount>1);
  check('paired controls have the same physical family and blocker topology',Boolean(reference&&candidate)
    &&['terrain','water'].includes(reference.family)&&[0,1,2].includes(reference.blockerCount)
    &&reference.family===candidate.family&&reference.blockerCount===candidate.blockerCount);
  const facts={referenceRepeatAdded:[],referenceKeyOnlySelectorOrder:false,referenceSourceOnlyPrefixOrder:false,
    referenceRepeatMatchesCandidatePreparation:false,legacyIncompleteObservations:legacy};
  for(const [implementation,row,sources] of [['reference',reference,referenceSources],['candidate',candidate,candidateSources]]) {
    const prepared=rows(row?.prepared),drawn=rows(row?.drawn),repeated=rows(row?.repeated),third=rows(row?.third);
    check(`${implementation} prepared/drawn/repeated have unique linked native identities and captured sources`,
      validSet(row?.prepared,sources)&&validSet(row?.drawn,sources)&&validSet(row?.repeated,sources));
    observed(`${implementation} third capture has unique linked native identities and sources`,Array.isArray(row?.third),()=>validSet(third,sources));
    check(`${implementation} all prepared identities/key/source survive first draw`,retains(prepared,drawn,sources));
    check(`${implementation} all first-draw identities/key/source survive repeat`,retains(drawn,repeated,sources));
    observed(`${implementation} all repeat identities/key/source survive third draw`,Array.isArray(row?.third),()=>retains(repeated,third,sources));
    for(const phase of ['preparedToDrawn','drawnToRepeated','repeatedToThird']) {
      observed(`${implementation} actual object retention ${phase}`,typeof row?.objectRetention?.[phase]==='boolean',()=>row.objectRetention[phase]===true);
    }
    const current=drawn.find(program=>program.id===row?.currentId);
    check(`${implementation} observed first current is the correct union/SCREEN program`,Boolean(current)
      &&current.unionDefine===String(union)&&current.screenDefine==='1');
    observed(`${implementation} first current native identity was captured`,Number.isInteger(row?.currentNativeId),
      ()=>Boolean(selected(drawn,row.currentId,row.currentNativeId)));
    observed(`${implementation} repeat current native identity was captured`,Number.isInteger(row?.repeatedCurrentId)&&Number.isInteger(row?.repeatedCurrentNativeId),
      ()=>Boolean(selected(repeated,row.repeatedCurrentId,row.repeatedCurrentNativeId)));
    observed(`${implementation} third current native identity was captured`,Number.isInteger(row?.thirdCurrentId)&&Number.isInteger(row?.thirdCurrentNativeId),
      ()=>Boolean(selected(third,row.thirdCurrentId,row.thirdCurrentNativeId)));
    check(`${implementation} native repeat difference counter is zero`,row?.repeatChanged===0);
    observed(`${implementation} native third difference counter is zero`,Number.isInteger(row?.thirdChanged),()=>row.thirdChanged===0);
    check(`${implementation} first native sample is full unsigned RGBA16F`,validBits(row?.nativeBits));
    observed(`${implementation} raw repeat native sample is bit-exact`,Array.isArray(row?.secondNativeBits),()=>equalBits(row.nativeBits,row.secondNativeBits));
    observed(`${implementation} raw third native sample is bit-exact`,Array.isArray(row?.thirdNativeBits),
      ()=>equalBits(row.nativeBits,row.thirdNativeBits)&&equalBits(row.secondNativeBits,row.thirdNativeBits));
    observed(`${implementation} third repeat adds no programs and keeps all keys/native identities`,Array.isArray(row?.third),()=>sameSet(repeated,third,sources));
    observed(`${implementation} third current preserves the repeated native program`,Number.isInteger(row?.repeatedCurrentId)
      &&Number.isInteger(row?.repeatedCurrentNativeId)&&Number.isInteger(row?.thirdCurrentId)&&Number.isInteger(row?.thirdCurrentNativeId),
    ()=>identity(selected(repeated,row.repeatedCurrentId,row.repeatedCurrentNativeId),selected(third,row.thirdCurrentId,row.thirdCurrentNativeId)));
    observed(`${implementation} third current preserves the actual program object`,typeof row?.currentObjects?.thirdMatchesRepeated==='boolean',
      ()=>row.currentObjects.thirdMatchesRepeated===true);
    if(implementation==='reference') {
      const firstAdded=added(prepared,drawn),repeatAdded=added(drawn,repeated);
      check('reference first preparation lacks the explicit selected union prefix',prepared.length===1&&prepared[0].unionDefine===null);
      check('reference first draw adds exactly one actual unprepared program',drawn.length===2&&firstAdded.length===1&&identity(firstAdded[0],current));
      check('reference repeat adds exactly one program',repeated.length===3&&repeatAdded.length===1);
      const next=repeatAdded[0];facts.referenceRepeatAdded=repeatAdded.map(program=>({id:program.id,nativeId:program.nativeId}));
      const before=`SURFACE_CLOUD_SCREEN,1,STELLAR_UNION_OCCLUSION,${union},`;
      const after=`STELLAR_UNION_OCCLUSION,${union},SURFACE_CLOUD_SCREEN,1,`;
      facts.referenceKeyOnlySelectorOrder=Boolean(current&&next&&exactReplace(current.cacheKey,before,after)===next.cacheKey);
      check('reference repeat key changes only the two selector positions',facts.referenceKeyOnlySelectorOrder);
      facts.referenceSourceOnlyPrefixOrder=Boolean(current&&next&&sourcesFor(current,sources)&&sourcesFor(next,sources)
        &&prefixSwap(sources[current.vertexSha256],sources[next.vertexSha256],union)
        &&prefixSwap(sources[current.fragmentSha256],sources[next.fragmentSha256],union));
      check('reference repeat source changes only the generated selector-prefix order',facts.referenceSourceOnlyPrefixOrder);
      observed('reference repeat actually selects that single introduced native program',Number.isInteger(row?.repeatedCurrentId)&&Number.isInteger(row?.repeatedCurrentNativeId),
        ()=>identity(next,selected(repeated,row.repeatedCurrentId,row.repeatedCurrentNativeId)));
      observed('reference repeat actually changes the current program object',typeof row?.currentObjects?.repeatedMatchesFirst==='boolean',
        ()=>row.currentObjects.repeatedMatchesFirst===false);
    } else {
      check('candidate first draw retains exactly the prepared program/key/native set',sameSet(prepared,drawn,sources));
      check('candidate first current was actually prepared',prepared.some(program=>identity(program,current)));
      check('candidate repeat retains exactly the first-draw program/key/native set',sameSet(drawn,repeated,sources));
      observed('candidate repeat current preserves first native identity',Number.isInteger(row?.repeatedCurrentId)&&Number.isInteger(row?.repeatedCurrentNativeId),
        ()=>identity(current,selected(repeated,row.repeatedCurrentId,row.repeatedCurrentNativeId)));
      observed('candidate repeat current preserves the actual program object',typeof row?.currentObjects?.repeatedMatchesFirst==='boolean',
        ()=>row.currentObjects.repeatedMatchesFirst===true);
    }
  }
  const repeatAdded=added(reference?.drawn,reference?.repeated),candidatePrepared=rows(candidate?.prepared);
  facts.referenceRepeatMatchesCandidatePreparation=repeatAdded.length===1&&candidatePrepared.length===1
    &&sameSource(repeatAdded[0],candidatePrepared[0],referenceSources,candidateSources);
  check('reference introduced key and complete sources equal candidate first preparation',facts.referenceRepeatMatchesCandidatePreparation);
  const unobserved=checks.filter(value=>value.status==='unobserved').map(value=>value.name);
  return {family:reference?.family,blockerCount:reference?.blockerCount,complete:!unobserved.length,
    passed:checks.every(value=>value.status==='pass'),checks,facts,unobserved};
}
