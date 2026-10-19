// Bootstrap until GitHub Actions expands the checked-in Brotli source.
import fs from 'node:fs';
import path from 'node:path';
import {brotliDecompressSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const target=path.join(here,'.catalog-batch.generated.js');
const bytes=brotliDecompressSync(fs.readFileSync(path.join(here,'catalog-batch.js.br')));
fs.writeFileSync(target+'.tmp',bytes);fs.renameSync(target+'.tmp',target);
const source=await import(pathToFileURL(target).href);
export const parseArgs=source.parseArgs,normalizeCatalog=source.normalizeCatalog;
export const StartLimiter=source.StartLimiter,waitForBase=source.waitForBase;
export const makeManifest=source.makeManifest,summary=source.summary;
export const GithubPublisher=source.GithubPublisher;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  source.main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
}
