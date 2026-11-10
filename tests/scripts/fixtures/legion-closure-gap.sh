#!/usr/bin/env bash
set -euo pipefail
cd "${1:?Repository root is required}"
"${NODE_BINARY:-node}" --input-type=module - <<'NODE'
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fingerprintInputs,fingerprintFunctionGraph} from './scripts/lib/cms-component-receipt.mjs';
const exec=promisify(execFile), root=process.cwd();
const scratch=await mkdtemp(join(tmpdir(),'route-d-api-closure-'));
const git=async(...args)=>(await exec('git',args,{cwd:scratch})).stdout.trim();
try {
 await exec('git',['clone','--quiet','--shared','--no-checkout',root,scratch]);
 await git('checkout','--quiet','--detach','HEAD');
 await symlink(join(root,'node_modules'),join(scratch,'node_modules'));
 const base=await git('rev-parse','HEAD');
 const baseApi=await fingerprintInputs(base,'cmsApi',{cwd:scratch});
 const compile=()=>build({entryPoints:[join(scratch,'cms-api/src/content-ops.ts')],bundle:true,platform:'node',format:'esm',packages:'external',write:false,metafile:true,define:{'import.meta.env':JSON.stringify({DEV:false,VITE_CMS_HOME_LAYOUTS_ENABLED:'false'})},logLevel:'silent'});
 const before=await compile();
 const file=join(scratch,'admin/src/lib/content-save-request.ts');
 const source=await readFile(file,'utf8');
 const needle='document: { ...content, type: kind },';
 if (!source.includes(needle)) throw new Error('Fixture owner not found');
 await writeFile(file,source.replace(needle,'document: { ...content, type: kind, title: "Changed API request title" },'));
 await git('add','admin/src/lib/content-save-request.ts');
 await git('-c','user.name=Contract fixture','-c','user.email=contract@example.test','commit','--quiet','-m','Change API-consumed Admin request builder');
 const candidate=await git('rev-parse','HEAD');
 const after=await compile();
 await git('checkout','--quiet','--detach',base);
 const unrelatedFile=join(scratch,'admin/src/lib/control-presentation-store.ts');
 await writeFile(unrelatedFile,(await readFile(unrelatedFile,'utf8'))+'\n// Unrelated Admin-only fixture edit.\n');
 await git('add','admin/src/lib/control-presentation-store.ts');
 await git('-c','user.name=Contract fixture','-c','user.email=contract@example.test','commit','--quiet','-m','Change unrelated Admin-only source');
 const unrelated=await git('rev-parse','HEAD');
 const unrelatedBundle=await compile();
 await git('checkout','--quiet','--detach',base);
 const compilerFile=join(scratch,'admin/tsconfig.json');
 const compiler=JSON.parse(await readFile(compilerFile,'utf8'));
 compiler.compilerOptions.useDefineForClassFields=false;
 await writeFile(compilerFile,JSON.stringify(compiler));
 await git('add','admin/tsconfig.json');
 await git('-c','user.name=Contract fixture','-c','user.email=contract@example.test','commit','--quiet','-m','Change bundled Admin compiler settings');
 const compilerCandidate=await git('rev-parse','HEAD');
 await git('checkout','--quiet','--detach',base);
 const apiSource=join(scratch,'cms-api/src/content-ops.ts');
 await writeFile(apiSource,(await readFile(apiSource,'utf8'))+'\nexport {cmsClosureProbe} from "../../admin/src/lib/cms-closure-probe";\n');
 const tsxFile=join(scratch,'admin/src/lib/cms-closure-probe.tsx');
 await writeFile(tsxFile,'import * as React from "react"; export const cmsClosureProbe = () => <span>API probe one</span>;');
 await git('add','cms-api/src/content-ops.ts','admin/src/lib/cms-closure-probe.tsx');
 await git('-c','user.name=Contract fixture','-c','user.email=contract@example.test','commit','--quiet','-m','Bundle a TSX Admin helper with a hoisted dependency');
 const tsxBase=await git('rev-parse','HEAD'),tsxBefore=await compile();
 await writeFile(tsxFile,(await readFile(tsxFile,'utf8')).replace('API probe one','API probe two'));
 await git('add','admin/src/lib/cms-closure-probe.tsx');
 await git('-c','user.name=Contract fixture','-c','user.email=contract@example.test','commit','--quiet','-m','Change only the bundled TSX helper');
 const tsxCandidate=await git('rev-parse','HEAD'),tsxAfter=await compile();
 const digest=x=>createHash('sha256').update(x).digest('hex');
 const results={base,candidate,changedFiles:await git('diff','--name-only',base,candidate),
  cmsApiInputsEqual:baseApi===await fingerprintInputs(candidate,'cmsApi',{cwd:scratch}),
  tsxAndHoistedDependencyCovered:await fingerprintInputs(tsxBase,'cmsApi',{cwd:scratch})!==await fingerprintInputs(tsxCandidate,'cmsApi',{cwd:scratch})&&digest(tsxBefore.outputFiles[0].contents)!==digest(tsxAfter.outputFiles[0].contents),
  adminCompilerInputsEqual:baseApi===await fingerprintInputs(compilerCandidate,'cmsApi',{cwd:scratch}),
  unrelatedAdminInputsEqual:baseApi===await fingerprintInputs(unrelated,'cmsApi',{cwd:scratch}),
  unrelatedApiBundleEqual:digest(before.outputFiles[0].contents)===digest(unrelatedBundle.outputFiles[0].contents),
  functionsInputsEqual:await fingerprintInputs(base,'functions',{cwd:scratch})===await fingerprintInputs(candidate,'functions',{cwd:scratch}),
  functionsGraphEqual:JSON.stringify(await fingerprintFunctionGraph(base,{cwd:scratch}))===JSON.stringify(await fingerprintFunctionGraph(candidate,{cwd:scratch})),
  apiBundleConsumesChangedOwner:Object.keys(after.metafile.inputs).some(path=>path.endsWith('admin/src/lib/content-save-request.ts')),
  apiBundleChanged:digest(before.outputFiles[0].contents)!==digest(after.outputFiles[0].contents)};
 if (!results.tsxAndHoistedDependencyCovered||results.cmsApiInputsEqual||results.adminCompilerInputsEqual||!results.unrelatedAdminInputsEqual||!results.unrelatedApiBundleEqual||!results.functionsInputsEqual||!results.functionsGraphEqual||!results.apiBundleConsumesChangedOwner||!results.apiBundleChanged) throw new Error('API closure regression');
 if (process.env.CLOSURE_GAP_REPORT) await writeFile(process.env.CLOSURE_GAP_REPORT,JSON.stringify(results,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(results));
} finally {await rm(scratch,{recursive:true,force:true});}
NODE
