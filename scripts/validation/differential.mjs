/** External mock oracle: compare semantic outcomes, not refactored source hashes. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

if(process.argv.length<5)throw new Error('Usage: differential.mjs BASELINE_SOURCE CANDIDATE_SOURCE OUTPUT --baseline-manifest FILE --baseline-sha256 SHA256 [--legacy-only] [--oracle FILE]');
const baseline=resolve(process.argv[2]);
const candidate=resolve(process.argv[3]);
const output=resolve(process.argv[4]);
const option=name=>{const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw new Error(`Required option: ${name}`);return process.argv[index+1];};
const baselineManifest=resolve(option('--baseline-manifest'));
const expectedManifestSha256=option('--baseline-sha256');
assert.match(expectedManifestSha256,/^[0-9a-f]{64}$/,'reviewed historical manifest SHA-256 is required');
assert.equal(createHash('sha256').update(readFileSync(baselineManifest)).digest('hex'),expectedManifestSha256,'historical manifest fingerprint differs');
const legacyOnly=process.argv.includes('--legacy-only');
const oracleIndex=process.argv.indexOf('--oracle');
const oracle=oracleIndex<0?undefined:JSON.parse(readFileSync(process.argv[oracleIndex+1],'utf8'));
if(oracle)assert.equal(oracle.baselineManifestSha256,expectedManifestSha256);
// Supply the historical fixture's anchor externally; never embed deployment IDs.
const channel=process.env.BASELINE_CHANNEL_ID;
assert.match(channel??'',/^[CG][A-Z0-9]+$/,'BASELINE_CHANNEL_ID must identify the external historical channel fixture');
const own = 'UBOT', human = 'UHUMAN', peer = 'UPEER', readonly = 'CREADONLY';
const scopes = ['channels:read','groups:read','im:read','mpim:read','channels:history','groups:history','im:history',
  'chat:write','im:write','reactions:write','users:read','files:read','files:write'];
const importAt = (root, path) => import(pathToFileURL(join(root, path)).href);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanError = async action => {try {await action(); return 'accepted';} catch {return 'refused';}};
function sourceFingerprint(root){
  const digest=createHash('sha256');
  for(const name of readdirSync(join(root,'src')).filter(name=>name.endsWith('.ts')).sort()){
    digest.update(name+'\0');digest.update(readFileSync(join(root,'src',name)));digest.update('\0');
  }
  return digest.digest('hex');
}
const normalize = value => JSON.parse(JSON.stringify(value, (_key, item) => {
  if (Buffer.isBuffer(item)) return {bytes:item.length, shaFreeFixture:true};
  if (typeof item === 'string') return item.replaceAll(channel, 'CWRITE');
  return item;
}));
const comparableRouting=receipt=>receipt&&Object.fromEntries([
  'routingVersion','wakeAllowed','routingReason','replyRoot','authority','botUserId','mentionIds','isBot','supportAccess','dmAuthorizedPeer',
].filter(key=>key in receipt).map(key=>[key,receipt[key]]));

async function api(root, isCandidate) {
  const [{SlackAdapter}, {SlackMcplServer}, harness, core] = await Promise.all([
    importAt(root,'src/slack-adapter.ts'), importAt(root,'src/server.ts'),
    importAt(root,'test/harness.ts'), importAt(root,'node_modules/@animalabs/mcpl-core/dist/src/index.js'),
  ]);
  return {root,isCandidate,SlackAdapter,SlackMcplServer,...harness,method:core.method};
}

async function fixture(api, {advanced=true,dmUsers=[],filePaths=true,scopeSet=scopes}={}) {
  const dir=mkdtempSync(join(tmpdir(),'connector-parity-'));chmodSync(dir,0o700);
  const previous={...process.env};
  for(const key of ['SLACK_ROUTING_STATE_FILE','SLACK_RECIPIENT_ID','SLACK_ROUTING_CHANNEL',
    'SUPPORT_ACCESS_HOST_FILTER','SLACK_RECIPIENT_HOST_FILTER','SLACK_ACCESS_POLICY','SLACK_SEND_CHANNELS',
    'SLACK_BOT_TOKEN','SLACK_PEER_BOT_PERMIT_FILE']) delete process.env[key];
  Object.assign(process.env,{SLACK_BACKSCROLL_LIMIT:'0',SLACK_SUBSCRIPTIONS_FILE:join(dir,'subscriptions.json')});
  const policy={writeChannels:[channel],dmUsers,readJoinedChannels:true};
  if(advanced&&!api.isCandidate) Object.assign(process.env,{SLACK_ROUTING_STATE_FILE:join(dir,'routing.sqlite'),
    SLACK_RECIPIENT_ID:own,SLACK_ROUTING_CHANNEL:channel,SUPPORT_ACCESS_HOST_FILTER:'v1',SLACK_RECIPIENT_HOST_FILTER:'v1'});
  const calls=[],effects=[],messages=[],downloads=[];
  let callback, member=true, fileChannel=channel, parentExists=true, redirectResponse=false, sent=100;
  const meta=id=>id.startsWith('D')?{id,is_im:true,is_mpim:false,user:human}:
    {id,name:id,is_im:false,is_mpim:false,is_private:id.startsWith('G'),is_member:id==='CUNJOINED'?false:member};
  const record=(name,result={})=>async args=>{effects.push([name,args]);return result;};
  const files=[{id:'FFILE',name:'file.txt',mimetype:'text/plain',url_private:'https://files.slack.com/message-url'}];
  const web={
    users:{info:async({user})=>({user:{name:user,...(user==='UUNKNOWN'?{}:{is_bot:user===peer})}}),list:async()=>({members:[]})},
    conversations:{
      list:async args=>{calls.push(['list',args]);return{channels:[meta(channel),meta(readonly),meta('GPRIVATE'),meta('CUNJOINED')]};},
      info:async({channel:id})=>{calls.push(['info',id]);return{channel:meta(id)};},
      open:async args=>{effects.push(['dm-open',args]);return{channel:{id:'DTEST'}};},
      history:async args=>{calls.push(['history',args]);return{messages:[{ts:'5.0',user:human,text:'fixture',files}]};},
      replies:async args=>{calls.push(['replies',args]);return{messages:parentExists?[{ts:args.ts,user:human,text:'fixture',files}]:[]};},
    },
    chat:{postMessage:async args=>{effects.push(['post',args]);return{ts:`${++sent}.0`};},update:record('edit'),delete:record('delete')},
    filesUploadV2:async args=>{effects.push(['upload',{...args,file:{bytes:args.file.length,isBuffer:Buffer.isBuffer(args.file)}}]);return{files:[{files:[{id:'FFILE'}]}]};},
    files:{delete:record('file-delete'),info:async args=>{calls.push(['file-info',args]);return{file:{id:args.file,channels:[fileChannel],url_private:'https://files.slack.com/files-pri/TTEST-FFILE/canonical.txt'}};}},
    reactions:{add:record('ack'),remove:record('ack-remove')},assistant:{threads:{setStatus:record('status')}},
  };
  const socket={on(_name,handler){callback=handler;},async start(){},async disconnect(){}};
  const adapter=new api.SlackAdapter(web,socket,own,'fixture',undefined,undefined,false,'eyes',scopeSet);
  if(advanced){
    adapter.configureAccessPolicy(policy);
    if(api.isCandidate){
      assert.equal(typeof adapter.configureRecipientRouting,'function','candidate recipient API is ready');
      adapter.configureRecipientRouting({stateFile:join(dir,'routing.sqlite'),namespace:channel,expectedBotUserId:own});
    }
  }
  adapter.onMessage(message=>messages.push(message));
  const server=new api.SlackMcplServer(adapter,{subscribeMemberChannels:true,
    // Historical source keeps its old API; v2 must opt into unrestricted mode explicitly.
    ...(api.isCandidate ? {pathUploads:filePaths?{mode:'unrestricted'}:undefined} : {allowFilePaths:filePaths}),
    ...(advanced?{disabledTools:['subscribe_channel','unsubscribe_channel']}:{})});
  const host=api.connectHost(server);
  const clientCapabilities={experimental:{mcpl:{version:'0.5'},
    ...(advanced&&api.isCandidate?{slackRecipientRouting:{version:1,botUserId:own,contextOnly:true,frozenReply:true,frozenStatus:true,provenance:true}}:{})}};
  await host.host.sendRequest(api.method.INITIALIZE,{protocolVersion:'2024-11-05',capabilities:clientCapabilities,clientInfo:{name:'parity-fixture',version:'1'}});
  host.host.sendNotification('notifications/initialized');
  await host.host.sendRequest(api.method.FEATURE_SETS_UPDATE,{effectiveCapabilities:api.FULL_GRANT});
  await api.until(()=>host.hostSaw.some(request=>request.method===api.method.CHANNELS_REGISTER),'parity registration');
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{downloads.push({url:String(url),redirect:options?.redirect});
    return redirectResponse?new Response(null,{status:302,headers:{Location:'https://untrusted.example/never-fetch'}}):new Response('fixture',{headers:{'content-type':'text/plain'}});};
  return {adapter,server,host,web,dir,calls,effects,messages,downloads,
    member(value){member=value;},fileChannel(value){fileChannel=value;},parentExists(value){parentExists=value;},
    redirect(value){redirectResponse=value;},
    tool:async(name,args)=>host.host.sendRequest('tools/call',{name,arguments:args}),
    async emit(id,text,extra={}){callback({event:{type:'message',channel,channel_type:'channel',user:human,ts:id,text,...extra},ack:async()=>{}});await sleep(25);},
    async close(){await host.close();server.close?.();await adapter.stop();adapter.routing?.close();globalThis.fetch=oldFetch;
      for(const key of Object.keys(process.env)) if(!(key in previous)) delete process.env[key];Object.assign(process.env,previous);rmSync(dir,{recursive:true,force:true});},
  };
}

const cases=[];
function scenario(name,run,advanced=true){cases.push({name,run,advanced});}

scenario('legacy tool surface and inline upload',async api=>{
  const h=await fixture(api,{advanced:false});try{
    const listed=await h.host.host.sendRequest('tools/list',{});
    const result=await h.tool('upload_file',{channelId:channel,filename:'a.txt',content:'fixture'});
    assert.notEqual(result.isError,true);
    return {tools:listed.tools.map(t=>({name:t.name,classes:t._meta?.['mcpl/class']})),effects:h.effects};
  }finally{await h.close();}
},false);
scenario('legacy bot/self filtering',async api=>{
  const h=await fixture(api,{advanced:false});try{
    await h.emit('1.0','<@UBOT> human');await h.emit('2.0','<@UBOT> bot',{user:peer,bot_id:'BPEER'});
    await h.emit('3.0','own',{user:own});
    assert.deepEqual(h.messages.map(m=>m.id),['1.0']);
    return{delivered:h.messages.map(m=>({id:m.id,mentions:m.mentionIds,isDM:m.isDM})),posts:h.effects.filter(e=>e[0]==='post')};
  }finally{await h.close();}
},false);
scenario('joined/read-only/unjoined/private read and write split',async api=>{
  const h=await fixture(api);try{
    const listed=await h.adapter.listConversations(true);
    const outcomes={readOnlyRead:await cleanError(()=>h.adapter.fetchHistory(readonly)),
      privateRead:await cleanError(()=>h.adapter.fetchThread('GPRIVATE','5.0')),
      unjoinedRead:await cleanError(()=>h.adapter.fetchHistory('CUNJOINED')),
      readOnlyWrite:await cleanError(()=>h.adapter.sendMessage(readonly,'deny')),
      write:await cleanError(()=>h.adapter.sendMessage(channel,'allow'))};
    assert.deepEqual(outcomes,{readOnlyRead:'accepted',privateRead:'accepted',unjoinedRead:'refused',readOnlyWrite:'refused',write:'accepted'});
    return{listed:listed.map(c=>({id:c.id,kind:c.kind,isMember:c.isMember})),outcomes,effects:h.effects};
  }finally{await h.close();}
});
scenario('missing scope and revoked membership fail before effects',async api=>{
  const h=await fixture(api,{scopeSet:['channels:read','channels:history']});try{
    const scope=await cleanError(()=>h.adapter.sendMessage(channel,'deny'));
    h.member(false);const revoked=await cleanError(()=>h.adapter.fetchHistory(channel));
    assert.equal(scope,'refused');assert.equal(revoked,'refused');assert.equal(h.effects.length,0);
    return{scope,revoked,effects:h.effects};
  }finally{await h.close();}
});
for(const open of [false,true])scenario(`recipient routing and frozen targets: ${open?'open':'closed'} lane`,async api=>{
  const h=await fixture(api);try{
    if(open)await h.host.host.sendRequest(api.method.CHANNELS_OPEN,{channelId:`slack:${channel}`,type:'slack'});
    await h.emit('1.0','<@UBOT> first',{thread_ts:'10.0'});
    await h.emit('2.0','<@UOTHER> context',{thread_ts:'99.0'});
    for(let n=3;n<=6;n++)await h.emit(`${n}.0`,'<@UBOT> peer',{user:peer,bot_id:'BPEER',thread_ts:'10.0'});
    await h.emit('6.0','<@UBOT> duplicate',{user:peer,bot_id:'BPEER',thread_ts:'10.0'});
    await h.emit('7.0','<@UBOT> own',{user:own,bot_id:'BSELF'});
    assert.deepEqual(h.messages.map(m=>m.routing.wakeAllowed),[true,false,true,true,true,true]);
    assert.equal(h.server.lastIncomingRoot.get(channel),'10.0');
    const result=await h.host.host.sendRequest(api.method.CHANNELS_PUBLISH,{channelId:`slack:${channel}`,threadId:'10.0',content:[{type:'text',text:'reply'}]});
    const missing=await h.host.host.sendRequest(api.method.CHANNELS_PUBLISH,{channelId:`slack:${channel}`,content:[{type:'text',text:'no target'}]});
    h.parentExists(false);
    const deleted=await h.host.host.sendRequest(api.method.CHANNELS_PUBLISH,{channelId:`slack:${channel}`,threadId:'999.0',content:[{type:'text',text:'deleted target'}]});
    assert.equal(result.delivered,true);assert.equal(missing.delivered,false);assert.equal(deleted.delivered,false);
    const messages=h.messages.map(m=>({id:m.id,authorId:m.authorId,senderKind:m.senderKind,isBot:m.isBot,
      mentionIds:m.mentionIds,routing:comparableRouting(m.routing)}));
    for(const message of h.messages){
      if('senderKind' in message.routing)assert.equal(message.routing.senderKind,message.senderKind);
      if('authorId' in message.routing)assert.equal(message.routing.authorId,message.authorId);
    }
    const lane=h.host.hostSaw.filter(r=>r.method===(open?api.method.CHANNELS_INCOMING:api.method.PUSH_EVENT)).map(r=>r.method);
    if(api.isCandidate){
      const metadata=h.host.hostSaw.filter(r=>r.method===(open?api.method.CHANNELS_INCOMING:api.method.PUSH_EVENT))
        .flatMap(r=>open?r.params.messages.map(message=>message.metadata):[r.params.origin]);
      for(let i=0;i<metadata.length;i++){
        assert.equal(metadata[i].messageId,h.messages[i].id);
        assert.equal(metadata[i].channelId,channel);
      }
    }
    return{messages,lane,effects:h.effects.filter(e=>['ack','post'].includes(e[0])),publish:{delivered:result.delivered,missing:missing.delivered,deleted:deleted.delivered}};
  }finally{await h.close();}
});
for(const allowed of [false,true])scenario(`DM peer authorization: ${allowed?'allowed':'empty list'}`,async api=>{
  const h=await fixture(api,{dmUsers:allowed?[human]:[]});try{
    await h.emit('1.0','hello',{channel:'DTEST',channel_type:'im'});
    assert.equal(h.messages.length,allowed?1:0);
    if(allowed)assert.deepEqual(h.messages[0].mentionIds,[]);
    return{messages:h.messages.map(m=>({isDM:m.isDM,mentions:m.mentionIds,routing:comparableRouting(m.routing)})),effects:h.effects};
  }finally{await h.close();}
});
scenario('upload input refusals and bounded opt-in path bytes',async api=>{
  const h=await fixture(api);try{
    const invalid=[];
    for(const args of [{},{content:''},{contentBase64:'data:text/plain;base64,aGVsbG8='},{content:'x',contentBase64:'eA=='},{content:'x'.repeat(5*1024*1024+1)}]){
      const result=await h.tool('upload_file',{channelId:channel,filename:'a.txt',...args});invalid.push(result.isError===true);
    }
    assert.deepEqual(invalid,[true,true,true,true,true]);
    const path=join(h.dir,'local.txt');writeFileSync(path,'file fixture');
    const result=await h.tool('upload_file',{channelId:channel,path});
    assert.notEqual(result.isError,true);
    assert.equal(h.effects.find(e=>e[0]==='upload')[1].file.isBuffer,true);
    return{invalid,effects:h.effects};
  }finally{await h.close();}
});
scenario('history file references and protected canonical downloads',async api=>{
  const h=await fixture(api);try{
    const history=await h.tool('fetch_history',{channelId:channel});
    const text=JSON.parse(history.content[0].text).messages[0].attachments[0];
    const match=text.match(/fetch_attachment\((\{.*?\})\)/);assert.ok(match);
    const args=JSON.parse(match[1]);assert.deepEqual(args,{channelId:channel,fileId:'FFILE'});
    const success=await h.tool('fetch_attachment',args);assert.notEqual(success.isError,true);
    h.fileChannel('COTHER');const denied=await h.tool('fetch_attachment',args);assert.equal(denied.isError,true);
    assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].redirect,'error');
    h.fileChannel(channel);h.redirect(true);
    const redirect=await h.tool('fetch_attachment',args);assert.equal(redirect.isError,true);
    assert.equal(h.downloads.length,2);assert.ok(h.downloads.every(item=>new URL(item.url).host==='files.slack.com'));
    return{args,downloads:h.downloads,denied:denied.isError,redirectRefused:redirect.isError};
  }finally{await h.close();}
});

scenario('live-profile tool gating and file argument schemas',async api=>{
  const h=await fixture(api);try{
    const result=await h.host.host.sendRequest('tools/list',{});
    const tools=result.tools.map(tool=>({name:tool.name,classes:tool._meta?.['mcpl/class'],
      ...(tool.name==='fetch_attachment'?{required:tool.inputSchema.required}:{}),
      ...(tool.name==='upload_file'?{path:!!tool.inputSchema.properties.path}:{})}));
    assert.ok(!tools.some(tool=>['send_dm','subscribe_channel','unsubscribe_channel'].includes(tool.name)));
    const denied=await h.tool('subscribe_channel',{channelId:readonly});assert.equal(denied.isError,true);
    return{tools,subscriptionEditDenied:denied.isError};
  }finally{await h.close();}
});
scenario('typing follows the frozen old root rather than a later addressed arrival',async api=>{
  const h=await fixture(api);try{
    await h.emit('1.0','<@UBOT> first',{thread_ts:'10.0'});
    await h.emit('2.0','<@UBOT> next',{thread_ts:'20.0'});
    const type=(metadata,op='start')=>h.host.host.sendNotification(api.method.CHANNELS_TYPING,{channelId:`slack:${channel}`,op,metadata});
    type({supportRecipientReplyRoot:'10.0'});await sleep(25);
    type({supportRecipientReplyRoot:'10.0'},'stop');await sleep(25);
    const effects=h.effects.filter(effect=>effect[0]==='status');
    assert.equal(effects[0][1].thread_ts,'10.0');
    assert.ok(!effects.some(effect=>effect[1].thread_ts==='20.0'));
    return{effects};
  }finally{await h.close();}
});
scenario('upload and message rollback retains checkpoint boundaries',async api=>{
  const h=await fixture(api);try{
    const first=await h.tool('send_message',{channelId:channel,content:'before'});
    const file=await h.tool('upload_file',{channelId:channel,filename:'a.txt',content:'fixture'});
    assert.ok(file.state?.checkpoint);
    await h.tool('send_message',{channelId:channel,content:'after'});
    const rollback=await h.host.host.sendRequest(api.method.STATE_ROLLBACK,{featureSet:'slack.messaging',checkpoint:first.state.checkpoint});
    assert.equal(rollback.success,true);
    assert.equal(h.effects.filter(effect=>effect[0]==='file-delete').length,1);
    assert.equal(h.effects.filter(effect=>effect[0]==='delete').length,1);
    assert.equal(h.effects.find(effect=>effect[0]==='delete')[1].ts,'102.0');
    return{success:rollback.success,partial:!!rollback.reason,effects:h.effects.filter(effect=>['file-delete','delete'].includes(effect[0]))};
  }finally{await h.close();}
});
scenario('unknown sender provenance is conservative and membership denial cannot consume dedup',async api=>{
  const h=await fixture(api);try{
    await h.emit('1.0','<@UBOT> unknown sender',{user:'UUNKNOWN'});
    await h.emit('2.0','<@UOTHER> unknown context',{user:'UUNKNOWN'});
    h.member(false);await h.emit('3.0','<@UBOT> temporarily revoked',{channel:readonly});
    h.member(true);await h.emit('3.0','<@UBOT> same ID restored',{channel:readonly});
    assert.deepEqual(h.messages.map(message=>message.id),['1.0','2.0','3.0']);
    assert.deepEqual(h.messages.slice(0,2).map(message=>[message.senderKind,message.isBot,message.routing.authority,message.routing.wakeAllowed]),
      [['unknown',true,'peer-not-owner',true],['unknown',true,'peer-not-owner',false]]);
    return{messages:h.messages.map(message=>({id:message.id,kind:message.senderKind,isBot:message.isBot,routing:comparableRouting(message.routing)})),
      readonlyEffects:h.effects.filter(effect=>effect[1].channel===readonly)};
  }finally{await h.close();}
});
scenario('durable dedup restart and historical budget rows remain intact',async api=>{
  const {RoutingLedger}=await importAt(api.root,api.isCandidate?'src/recipient-routing.ts':'src/support-routing.ts');
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
  const dir=mkdtempSync(join(tmpdir(),'parity-ledger-'));chmodSync(dir,0o700);
  const path=join(dir,'ledger.sqlite'),policy={writeChannels:[channel],dmUsers:[],readJoinedChannels:true};
  let ledger=new RoutingLedger(path,own,channel,policy);
  const input=id=>({channel,id,root:'10.0',isBot:true,senderKind:'bot',authorId:peer,mentions:[own],
    access:{version:1,channelId:channel,kind:'channel',readable:true,joined:true}});
  try{
    const first=ledger.receive(input('1.0'));assert.equal(first.wakeAllowed,true);
    ledger.close();
    const seed=new DatabaseSync(path);
    seed.exec('CREATE TABLE IF NOT EXISTS budgets(channel TEXT,root TEXT,remaining INTEGER,expires INTEGER,PRIMARY KEY(channel,root))');
    seed.prepare('INSERT INTO budgets VALUES (?,?,?,?)').run(channel,'10.0',0,1);seed.close();
    ledger=new RoutingLedger(path,own,channel,policy);
    const duplicate=ledger.receive(input('1.0'));assert.equal(duplicate,null);
    const wakes=[];for(let n=2;n<=5;n++)wakes.push(ledger.receive(input(`${n}.0`)).wakeAllowed);
    assert.deepEqual(wakes,[true,true,true,true]);
    const inspect=new DatabaseSync(path),rows=inspect.prepare('SELECT * FROM budgets').all();inspect.close();
    assert.equal(rows[0].remaining,0);assert.equal(rows[0].expires,1);
    return{duplicate,wakes,rows};
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});

const sourceBefore=[sourceFingerprint(baseline),sourceFingerprint(candidate)];
const apis=oracle?[await api(candidate,true)]:[await api(baseline,false),await api(candidate,candidate!==baseline)];
const results=[];
for(const item of cases){
  if(legacyOnly&&item.advanced)continue;
  const outputs=[];
  if(oracle){const expected=oracle.cases.find(row=>row.name===item.name)?.baselineTrace;assert.ok(expected,'calibrated baseline trace is available');outputs.push(expected);}
  for(const side of apis)outputs.push(normalize(await item.run(side)));
  try{assert.deepEqual(outputs[1],outputs[0]);results.push({name:item.name,passed:true,baselineTrace:outputs[0],candidateTrace:outputs[1]});}
  catch(error){results.push({name:item.name,passed:false,baseline:outputs[0],candidate:outputs[1]});}
}
const receipt={baselineManifestSha256:expectedManifestSha256,
  sourceFingerprint:{baseline:sourceBefore[0],candidate:sourceBefore[1]},
  node:process.version,mode:legacyOnly?'legacy':'legacy-and-live-profile',cases:results,
  intentionalDifferences:['Candidate recipient mode additionally requires an explicit host capability attestation.',
    'Candidate default path uploads are disabled; live-profile parity opts in explicitly.',
    'Candidate ledger input uses senderKind; added senderKind/authorId provenance is separately checked against adapter identity fields.',
    'Candidate requires verified frozen roots for typing start and stop; unsafe missing/mismatched stop forms are tested as deliberate hardening, not expected d59d parity.',
    'Generalized namespaces and multi-channel policies need separate candidate-only tests.'],
  normalization:'Only the private baseline channel identifier is replaced with a synthetic label. Error wording and tool descriptions are not asserted by this semantic trace matrix.',
  summary:{passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length}};
assert.deepEqual([sourceFingerprint(baseline),sourceFingerprint(candidate)],sourceBefore,'source changed during parity run; rerun against a stable snapshot');
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({node:process.version,...receipt.summary,report:output}));
if(receipt.summary.failed)process.exitCode=1;
