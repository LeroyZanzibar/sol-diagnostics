import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {projectionRows,emptyConfiguration,validateConfiguration} from '../app/monthly-domain.mjs';
const cases=[];
for(const start of ['1900-01-01','2000-02-29','2023-02-28','2024-03-16','2024-12-31','2075-12-31'])for(const degradation of ['0','100','0.123456789012345678']){
 const configuration=validateConfiguration({...emptyConfiguration(),operationsStart:start,degradation,baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[i+1,{production:i===3?null:'999999999998.9999999',revenue:'123.1234567890123456',insolation:i===7?null:'0.000000000000000001'}]))});cases.push({configuration,rows:projectionRows(configuration)});
}
const result=spawnSync('python3',['tests/monthly-projection-oracle.py'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:1024*1024,timeout:120000});
assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
