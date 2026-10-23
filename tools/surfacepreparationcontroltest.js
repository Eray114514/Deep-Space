// Replay a frozen hardware transcript, then exercise the same classifier with
// explicitly synthetic observations and damaged controls. Synthetic completion
// cannot supply the repeat-current/third evidence missing from the old capture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';

const reportPath=process.argv.find(value=>value.startsWith('--report='))?.slice(9);
assert.ok(reportPath,'Pass --report=PATH to the unchanged first-run surface-prepare-identity report.json or report.json.gz');
const files=['tools/surface-preparation-control.js','tools/surfaceprepareidentitygputest.js','tools/surfacepreparationcontroltest.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async file=>[file,await readFile(new URL(`../${file}`,import.meta.url))])));
const {classifySurfacePreparationPair}=await import('./surface-preparation-control.js');
const inputBytes=await readFile(reportPath),inputJson=reportPath.endsWith('.gz')?gunzipSync(inputBytes):inputBytes;
const input=JSON.parse(inputJson.toString('utf8'));
const out=`test-results/surface-preparation-controls/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});for(const [file,bytes] of frozen)await writeFile(`${out}/${path.basename(file)}`,bytes);
await writeFile(`${out}/input-report.json`,inputJson);
async function inputTree() {
  const root=path.dirname(path.resolve(reportPath)),rows=[];
  const visit=async directory=>{
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()){const bytes=await readFile(file);rows.push({path:path.relative(root,file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha256(bytes)});}
    }
  };
  await visit(root);return {files:rows,sha256:sha256(JSON.stringify(rows))};
}
const treeBefore=await inputTree(),reference=input.pages?.find(page=>page.implementation==='reference'),candidate=input.pages?.find(page=>page.implementation==='candidate');
assert.equal(reference?.cases.length,6);assert.equal(candidate?.cases.length,6);
const subset=(row,sources)=>Object.fromEntries([...new Set(['prepared','drawn','repeated'].flatMap(stage=>row[stage].flatMap(p=>[p.vertexSha256,p.fragmentSha256])))].map(key=>[key,sources[key]]));
const pairs=reference.cases.map(row=>{
  const next=candidate.cases.find(value=>value.family===row.family&&value.blockerCount===row.blockerCount);
  assert.ok(next);return {reference:row,candidate:next,referenceSources:subset(row,reference.sources),candidateSources:subset(next,candidate.sources)};
});
const cases=[],legacyResults=[],negativeControls=[];
function test(name,work) {
  try {work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),actual:error?.actual,expected:error?.expected,stack:error?.stack});}
}
function synthetic(pair) {
  const result=structuredClone(pair);
  for(const [kind,row] of [['reference',result.reference],['candidate',result.candidate]]) {
    const first=row.drawn.find(p=>p.id===row.currentId);
    // These selections are controlled test inputs, NOT a reconstruction of
    // what the unrecorded second current did on the hardware run.
    const repeated=kind==='reference'?row.repeated.find(p=>!row.drawn.some(old=>old.id===p.id)):first;
    row.currentNativeId=first.nativeId;row.repeatedCurrentId=repeated.id;row.repeatedCurrentNativeId=repeated.nativeId;
    row.third=structuredClone(row.repeated);row.thirdCurrentId=repeated.id;row.thirdCurrentNativeId=repeated.nativeId;
    row.thirdChanged=0;row.secondNativeBits=row.nativeBits.slice();row.thirdNativeBits=row.nativeBits.slice();
    row.objectRetention={preparedToDrawn:true,drawnToRepeated:true,repeatedToThird:true};
    row.currentObjects={repeatedMatchesFirst:kind==='candidate',thirdMatchesRepeated:true};
  }
  return result;
}
function negative(name,mutate,expectedGate) {
  test(name,()=>{
    const observations=[];
    for(const pair of pairs) {
      const value=synthetic(pair);mutate(value);const result=classifySurfacePreparationPair(value),failed=result.checks.filter(check=>check.status==='fail');
      assert.equal(result.passed,false,`${name}: ${pair.reference.family}/${pair.reference.blockerCount} accepted damage`);
      assert.ok(failed.some(check=>check.name.includes(expectedGate)),`${name}: intended gate ${expectedGate} did not fail`);
      observations.push({family:result.family,blockerCount:result.blockerCount,failed:failed.map(check=>check.name)});
    }
    negativeControls.push({name,expectedGate,observations});
  });
}
const repeatAdded=value=>value.reference.repeated.find(p=>!value.reference.drawn.some(old=>old.id===p.id));
test('the unchanged failed capture reproduces exactly six reference stability failures',()=>{
  const failures=reference.checks.filter(check=>!check.passed);
  assert.equal(failures.length,6);assert.ok(failures.every(check=>check.name.endsWith('same-value repeat retains all actual programs')));
  assert.equal(candidate.checks.filter(check=>!check.passed).length,0);assert.equal(input.comparisons.length,6);
  assert.ok(input.comparisons.every(value=>value.nativeUint16Changed===0));
});
test('legacy replay verifies only observed program/key/source facts and stays incomplete',()=>{
  for(const pair of pairs) {
    const result=classifySurfacePreparationPair(pair,{legacy:true});legacyResults.push(result);
    assert.equal(result.checks.filter(check=>check.status==='fail').length,0);
    assert.equal(result.passed,false);assert.equal(result.complete,false);
    assert.ok(result.unobserved.includes('reference repeat current native identity was captured'));
    assert.ok(result.unobserved.includes('candidate repeat current native identity was captured'));
    assert.ok(result.unobserved.includes('reference third current native identity was captured'));
    assert.ok(result.facts.referenceKeyOnlySelectorOrder);assert.ok(result.facts.referenceSourceOnlyPrefixOrder);
    assert.ok(result.facts.referenceRepeatMatchesCandidatePreparation);
    assert.equal(Object.hasOwn(pair.reference,'repeatedCurrentId'),false);
    assert.equal(Object.hasOwn(pair.candidate,'repeatedCurrentId'),false);
  }
});
test('the new strict classifier rejects that same old transcript as acceptance evidence',()=>{
  for(const pair of pairs) {
    const result=classifySurfacePreparationPair(pair);assert.equal(result.passed,false);
    assert.ok(result.checks.some(check=>check.name==='reference repeat current native identity was captured'&&check.status==='fail'));
    assert.ok(result.checks.some(check=>check.name==='candidate third current native identity was captured'&&check.status==='fail'));
  }
});
test('explicit synthetic observations exercise all six complete intended state transitions',()=>{
  for(const pair of pairs) {
    const result=classifySurfacePreparationPair(synthetic(pair));assert.equal(result.complete,true);
    assert.equal(result.passed,true,JSON.stringify(result.checks.filter(check=>!check.passed)));
  }
});
negative('an extra reference macro is not classified as selector-order churn',value=>{
  const p=repeatAdded(value);value.referenceSources[p.fragmentSha256]=value.referenceSources[p.fragmentSha256].replace('#define SHADER_NAME ', '#define UNRELATED_SWITCH 1\n#define SHADER_NAME ');
},'reference repeat source changes only');
negative('a reference GLSL body edit is not classified as selector-order churn',value=>{
  const p=repeatAdded(value);value.referenceSources[p.vertexSha256]+='\nvoid unrequestedBodyChange(){}\n';
},'reference repeat source changes only');
negative('unrelated reference key edits cannot hide behind equal output',value=>{
  repeatAdded(value).cacheKey+=',EXTRA_KEY_STATE';
},'reference repeat key changes only');
negative('a retained reference program cannot silently change native identity',value=>{
  value.reference.repeated[0].nativeId+=10000;
},'reference all first-draw identities/key/source survive repeat');
negative('a retained candidate program cannot silently change native identity',value=>{
  value.candidate.repeated[0].nativeId+=10000;
},'candidate all first-draw identities/key/source survive repeat');
negative('deleting an existing reference program is a failure rather than successful no-new-program reuse',value=>{
  value.reference.repeated=value.reference.repeated.filter(p=>p.id!==value.reference.currentId);
},'reference all first-draw identities/key/source survive repeat');
negative('introducing two reference programs is never the precise one-program old defect',value=>{
  const p=structuredClone(repeatAdded(value));p.id+=10000;p.nativeId+=10000;p.cacheKey+=',SECOND_ADDED_PROGRAM';value.reference.repeated.push(p);
},'reference repeat adds exactly one program');
negative('reference repeat must actually select the introduced program rather than an older one',value=>{
  const row=value.reference,old=row.drawn.find(p=>p.id===row.currentId);row.repeatedCurrentId=old.id;row.repeatedCurrentNativeId=old.nativeId;
},'reference repeat actually selects that single introduced native program');
negative('a matching repeat program id with the wrong current native handle is rejected',value=>{
  value.reference.repeatedCurrentNativeId+=10000;
},'reference repeat current native identity was captured');
negative('serialized identities cannot substitute for actual reference current-object observation',value=>{
  value.reference.currentObjects.repeatedMatchesFirst=true;
},'reference repeat actually changes the current program object');
negative('candidate repeat still forbids even a single otherwise linked extra program',value=>{
  const row=value.candidate,p=structuredClone(row.repeated[0]);p.id+=10000;p.nativeId+=10000;p.cacheKey+=',CANDIDATE_EXTRA';row.repeated.push(p);
},'candidate repeat retains exactly the first-draw program/key/native set');
negative('candidate current identity cannot change despite native pixel equality',value=>{
  value.candidate.repeatedCurrentNativeId+=10000;
},'candidate repeat current preserves first native identity');
negative('candidate actual current object must remain the same',value=>{
  value.candidate.currentObjects.repeatedMatchesFirst=false;
},'candidate repeat current preserves the actual program object');
negative('candidate key must remain unchanged on every retained native program',value=>{
  value.candidate.repeated[0].cacheKey+=',UNRELATED_KEY';
},'candidate repeat retains exactly the first-draw program/key/native set');
negative('cross-version introduced/program-preparation key equality is independently required',value=>{
  for(const stage of ['prepared','drawn','repeated','third'])for(const p of value.candidate[stage])p.cacheKey+=',INDEPENDENT_STABLE_KEY';
},'reference introduced key and complete sources equal candidate first preparation');
negative('cross-version complete source equality is required even if candidate is internally stable',value=>{
  const p=value.candidate.prepared[0];value.candidateSources[p.fragmentSha256]+='\n// stable but unapproved candidate source\n';
},'reference introduced key and complete sources equal candidate first preparation');
negative('a third reference draw cannot continue adding programs',value=>{
  const row=value.reference,p=structuredClone(row.third.at(-1));p.id+=10000;p.nativeId+=10000;p.cacheKey+=',THIRD_CHURN';row.third.push(p);
},'reference third repeat adds no programs and keeps all keys/native identities');
negative('a third candidate draw cannot replace its current native program',value=>{
  value.candidate.thirdCurrentNativeId+=10000;
},'candidate third current preserves the repeated native program');
negative('deleting a program at the third reference draw still fails retention',value=>{
  value.reference.third.shift();
},'reference all repeat identities/key/source survive third draw');
negative('new captures cannot omit repeat current and infer it from the only introduced program',value=>{
  delete value.reference.repeatedCurrentId;delete value.reference.repeatedCurrentNativeId;
},'reference repeat actually selects that single introduced native program');
negative('new captures cannot omit the actual object-retention observation',value=>{
  delete value.reference.objectRetention.drawnToRepeated;
},'reference actual object retention drawnToRepeated');
negative('raw repeat native damage is caught even if its recorded difference counter remains zero',value=>{
  value.reference.secondNativeBits[0]^=1;
},'reference raw repeat native sample is bit-exact');
negative('a nonzero measured repeat difference cannot be overridden by equal copied arrays',value=>{
  value.candidate.repeatChanged=1;
},'candidate native repeat difference counter is zero');
negative('raw third native damage cannot pass as a stable same-value repeat',value=>{
  value.candidate.thirdNativeBits[0]^=1;
},'candidate raw third native sample is bit-exact');
negative('duplicate native handles do not count as distinct valid program observations',value=>{
  const row=value.reference;row.repeated.at(-1).nativeId=row.repeated[0].nativeId;
},'reference prepared/drawn/repeated have unique linked native identities');

const sources=[];
for(const [file,bytes] of frozen) {
  const after=await readFile(new URL(`../${file}`,import.meta.url));sources.push({path:file,bytes:bytes.length,sha256:sha256(bytes),
    afterSha256:sha256(after),stable:sha256(bytes)===sha256(after)});
}
const treeAfter=await inputTree(),inputStable=sha256(inputBytes)===sha256(await readFile(reportPath))&&treeBefore.sha256===treeAfter.sha256;
const report={scope:'CPU classifier replay and damaged synthetic transcripts; no GPU run, no reconstruction of unrecorded hardware current or third draw',
  input:{path:reportPath,sha256:sha256(inputBytes),archiveTreeSha256:treeBefore.sha256,archiveFiles:treeBefore.files,stable:inputStable,
    originalAcceptancePassed:input.passed,legacyReplayIsAcceptance:false},
  syntheticScope:'Repeat-current/object/third/raw-repeat fields below are deliberately chosen CPU inputs, not measurements from the frozen capture.',
  sources,passed:cases.filter(value=>value.passed).length,total:cases.length,cases,legacyResults,negativeControls};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,passed:report.passed,total:report.total,input:report.input,sources,cases},null,2));
assert.equal(inputStable,true,'Original failed evidence directory changed during CPU replay');
assert.ok(sources.every(value=>value.stable),'Surface preparation classifier/verifier changed during CPU contracts');
assert.equal(report.passed,report.total,'Surface preparation classification controls failed');
