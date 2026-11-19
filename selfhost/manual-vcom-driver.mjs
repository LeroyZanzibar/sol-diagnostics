import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';

/** Finite server-owned drain of already-authorized jobs; never creates a job.
 * It calls built routes, not lazy browser registrations or source TS imports. */
export class ManualVcomDriver {
  constructor({store,username,password,fetchImpl=fetch,deadlineMs=90000,spacingMs=2000}){
    this.store=store;this.authorization='Basic '+Buffer.from(`${username}:${password}`).toString('base64');
    this.token=randomBytes(32).toString('base64url');this.tokenHash=createHash('sha256').update(this.token).digest();
    this.fetchImpl=fetchImpl;this.deadlineMs=deadlineMs;this.spacingMs=spacingMs;this.stopping=false;this.activeWork=new Set();this.nextCall=0;
  }
  verifyWorker(token){return typeof token==='string'&&token.length<=128&&timingSafeEqual(createHash('sha256').update(token).digest(),this.tokenHash);}
  start(server){
    const address=server.address();if(!address||typeof address==='string'||!address.port)throw Error('A bound TCP listener is required for manual VCOM work.');
    const host=address.address==='::'||address.address==='::1'?'[::1]':'127.0.0.1';this.url=`http://${host}:${address.port}/api/manual-vcom/work`;this.wake();
  }
  wake(){if(this.stopping||!this.url||this.draining)return;this.schedule(0);}
  schedule(floor=0){
    clearTimeout(this.timer);if(this.stopping||!this.url)return;
    const delay=this.store.pendingDelay();if(delay===null)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.drain();},Math.max(floor,this.nextCall-Date.now(),Math.min(86400000,delay)));this.timer.unref();
  }
  async runWork(operation){
    if(this.stopping)throw Object.assign(new Error('Manual worker is stopping.'),{status:503});
    if(this.activeWork.size)throw Object.assign(new Error('Manual worker is busy.'),{status:409});
    const promise=Promise.resolve().then(operation);this.activeWork.add(promise);
    try{return await promise;}finally{this.activeWork.delete(promise);}
  }
  async drain(){
    if(this.stopping||this.draining)return;
    let failed=false;
    this.draining=(async()=>{
      this.abort=new AbortController();const timeout=setTimeout(()=>this.abort?.abort(),this.deadlineMs);timeout.unref();
      try{
        const response=await this.fetchImpl(this.url,{method:'POST',headers:{Authorization:this.authorization,'x-sol-vcom-worker':this.token,'content-type':'application/json'},body:'{}',redirect:'error',signal:this.abort.signal});
        // Keep response handling within the same deadline and bounded read.
        let size=0;for await(const bytes of response.body||[]){size+=bytes.length;if(size>4096)throw Error('Worker response exceeded its bound.');}
        if(!response.ok)throw Error('Manual worker request failed.');
      }catch{failed=true;/* No credentials, provider bodies or private tokens in logs. */}
      finally{clearTimeout(timeout);this.abort=null;this.nextCall=Date.now()+this.spacingMs;}
    })();
    try{await this.draining;}finally{this.draining=null;if(!this.stopping)this.schedule(failed?30000:0);}
  }
  async stop(){this.stopping=true;clearTimeout(this.timer);await this.draining;await Promise.allSettled([...this.activeWork]);}
}
