import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,fstatSync,constants,mkdirSync} from 'node:fs';
import {join} from 'node:path';

export class ManualVcomError extends Error {
  constructor(code,message,status=409){super(message);this.name='ManualVcomError';this.code=code;this.status=status;}
}
const keyError=()=>new ManualVcomError('credential-key-unavailable','The VCOM credential key is unavailable or does not match this installation. Restore its original private key.',503);
export function validateCredentials(value){
  const fields=value?.mode==='basic'?['apiKey','username','password']:value?.mode==='bearer'?['apiKey','accessToken']:null;
  if(!fields||fields.some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>4096||/[\u0000-\u001f]/.test(value[k]))||value.mode==='basic'&&value.username.includes(':'))throw new ManualVcomError('invalid-credentials','Supply complete, nonblank replacement credentials, or omit credentials to keep those saved.',400);
  return Object.fromEntries(['mode',...fields].map(k=>[k,value[k]]));
}
export class ManualVcomCredentials {
  constructor(sqlite,directory){
    this.sqlite=sqlite;this.path=join(directory,'manual-vcom-master.key');mkdirSync(directory,{recursive:true,mode:0o700});
    const identity=sqlite.prepare("SELECT key_id FROM vcom_key_identity WHERE id='vcom-v1'").get();
    if(!identity){
      if(sqlite.prepare('SELECT 1 FROM vcom_site_settings WHERE credentials IS NOT NULL LIMIT 1').get())throw keyError();
      let fd;
      try{fd=openSync(this.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,randomBytes(32));fsyncSync(fd);}
      catch(error){if(error.code!=='EEXIST')throw keyError();}
      finally{if(fd!==undefined)closeSync(fd);}
      const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir);}finally{closeSync(dir);}
      const key=this.read();const keyId=createHash('sha256').update(key).digest('hex');key.fill(0);
      sqlite.prepare("INSERT INTO vcom_key_identity(id,key_id) VALUES ('vcom-v1',?) ON CONFLICT(id) DO NOTHING").run(keyId);
    }
    this.assertAvailable();
  }
  read(){
    let fd;
    try{fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==32||(stat.mode&0o777)!==0o600)throw keyError();return readFileSync(fd);}
    catch{throw keyError();}finally{if(fd!==undefined)closeSync(fd);}
  }
  key(){
    const key=this.read(),identity=this.sqlite.prepare("SELECT key_id FROM vcom_key_identity WHERE id='vcom-v1'").get();
    if(!identity||createHash('sha256').update(key).digest('hex')!==identity.key_id){key.fill(0);throw keyError();}
    return {key,keyId:identity.key_id};
  }
  assertAvailable(){this.key().key.fill(0);}
  encrypt(siteId,value){
    const auth=validateCredentials(value),{key,keyId}=this.key(),iv=randomBytes(12);
    try{const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(Buffer.from(JSON.stringify(['vcom',1,siteId,keyId])));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify(auth),'utf8'),cipher.final()]);
      return JSON.stringify({version:1,keyId,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
    }finally{key.fill(0);}
  }
  decrypt(siteId,text){
    const {key,keyId}=this.key();
    try{const envelope=JSON.parse(text);if(envelope.version!==1||envelope.keyId!==keyId)throw keyError();
      const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');if(iv.length!==12||tag.length!==16)throw keyError();
      const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});decipher.setAAD(Buffer.from(JSON.stringify(['vcom',1,siteId,keyId])));decipher.setAuthTag(tag);
      return validateCredentials(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8')));
    }catch{throw keyError();}finally{key.fill(0);}
  }
}
