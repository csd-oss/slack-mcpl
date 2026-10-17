/** Explicitly test intended differences instead of normalizing them away. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
if(process.argv.length<4)throw new Error('Usage: intentional_contracts.mjs CANDIDATE_SOURCE OUTPUT');
const candidate=resolve(process.argv[2]);
const output=resolve(process.argv[3]);
const at=path=>import(pathToFileURL(join(candidate,path)).href);
const [{RoutingLedger},{SlackAdapter},{SlackMcplServer},harness]=await Promise.all([
  at('src/recipient-routing.ts'),at('src/slack-adapter.ts'),at('src/server.ts'),at('test/harness.ts'),
]);
const results=[];
const dir=mkdtempSync(join(tmpdir(),'generic-contracts-'));chmodSync(dir,0o700);
try{
  const policy={writeChannels:['CONE','CTWO'],dmUsers:['UHUMAN'],readJoinedChannels:true};
  if(Number(process.versions.node.split('.')[0])>=24){
    const ledger=new RoutingLedger(join(dir,'general.sqlite'),'UBOT','installation.alpha',policy);
    try{
      for(const channel of ['CONE','CTWO','CREAD']){
        const result=ledger.receive({channel,id:'1.0',root:'1.0',senderKind:'human',authorId:'UHUMAN',mentions:['UBOT'],
          access:{version:1,channelId:channel,kind:'channel',readable:true,joined:true}});
        assert.equal(result.wakeAllowed,true);
      }
      assert.throws(()=>ledger.receive({channel:'CONE',id:'2.0',root:'1.0',senderKind:'human',mentions:['UBOT']}),/admission/);
      results.push({name:'generic namespace and multiple write-channel policy',passed:true});
    }finally{ledger.close();}
    const dmOnly=new RoutingLedger(join(dir,'dm-only.sqlite'),'UBOT','installation.dm',{...policy,readJoinedChannels:false});
    try{
      assert.throws(()=>dmOnly.receive({channel:'CONE',id:'1.0',root:'1.0',senderKind:'human',mentions:['UBOT'],
        access:{version:1,channelId:'CONE',kind:'channel',readable:true,joined:true}}));
      const dm=dmOnly.receive({channel:'DTEST',id:'2.0',root:'2.0',senderKind:'human',authorId:'UHUMAN',mentions:[],dmAuthorizedPeer:'UHUMAN',
        access:{version:1,channelId:'DTEST',kind:'dm',readable:true,dmPeer:'UHUMAN'}});
      assert.equal(dm.wakeAllowed,true);assert.deepEqual(dm.mentionIds,[]);
      results.push({name:'readJoinedChannels=false with independent authorized DM',passed:true});
    }finally{dmOnly.close();}
    const core=await at('node_modules/@animalabs/mcpl-core/dist/src/index.js');
    const capability={version:1,botUserId:'UBOT',contextOnly:true,frozenReply:true,frozenStatus:true,provenance:true};
    for(const descriptor of [undefined,{...capability,provenance:false},capability]){
      const effects=[];let parentExists=true;
      const conversation={id:'CONE',name:'fixture',is_im:false,is_mpim:false,is_private:false,is_member:true};
      const adapter=new SlackAdapter({
        conversations:{list:async()=>({channels:[conversation]}),info:async()=>({channel:conversation}),
          replies:async({ts})=>({messages:parentExists?[{ts,user:'UHUMAN',text:'fixture'}]:[]})},
        assistant:{threads:{setStatus:async args=>{effects.push(args);return{};}}},
        users:{info:async()=>({user:{name:'fixture',is_bot:false}})},
      },{on(){}},'UBOT','fixture',undefined,undefined,false,undefined,['channels:read','channels:history','chat:write']);
      adapter.configureAccessPolicy({writeChannels:['CONE'],dmUsers:[],readJoinedChannels:true});
      adapter.configureRecipientRouting({stateFile:join(dir,`handshake-${results.length}-${descriptor?.provenance}.sqlite`),namespace:'installation.status'});
      const h=harness.connectHost(new SlackMcplServer(adapter,{subscribeMemberChannels:true}));
      h.served.catch(()=>{});
      const initialize=()=>h.host.sendRequest(core.method.INITIALIZE,{protocolVersion:'2024-11-05',
        capabilities:{experimental:{mcpl:{version:'0.5'},...(descriptor?{slackRecipientRouting:descriptor}:{})}},clientInfo:{name:'contract-fixture',version:'1'}});
      try{
        if(descriptor!==capability){await assert.rejects(initialize(),/slackRecipientRouting/);}
        else{
          const initialized=await initialize();
          assert.deepEqual(initialized.capabilities.experimental.slackRecipientRouting,capability);
          h.host.sendNotification('notifications/initialized');
          await h.host.sendRequest(core.method.FEATURE_SETS_UPDATE,{effectiveCapabilities:harness.FULL_GRANT});
          const type=async(root,op='start')=>{
            h.host.sendNotification(core.method.CHANNELS_TYPING,{channelId:'slack:CONE',op,metadata:root?{supportRecipientReplyRoot:root}:{}});
            await new Promise(resolve=>setTimeout(resolve,25));
          };
          await type('10.0');await type('20.0');
          const before=effects.length;
          await type('10.0','stop');await type(undefined,'stop');
          assert.equal(effects.length,before,'old/rootless stop must not clear a later root');
          parentExists=false;await type('20.0','stop');assert.equal(effects.length,before,'missing parent must refuse a stop');
          parentExists=true;await type('20.0','stop');
          assert.equal(effects.at(-1).thread_ts,'20.0');assert.equal(effects.at(-1).status,'');
          results.push({name:'verified frozen start/stop refuses stale, rootless and missing-parent effects',passed:true});
        }
      }finally{await h.close().catch(()=>{});await adapter.stop();}
    }
    results.push({name:'advanced handshake rejects missing/partial support and echoes the complete contract',passed:true});
  }else{
    assert.throws(()=>new RoutingLedger(join(dir,'unsupported.sqlite'),'UBOT','installation.alpha',policy),/Node 24/);
    results.push({name:'advanced routing refuses unsupported Node major',passed:true});
  }
  for(const allowFilePaths of [false,true]){
    const uploads=[];
    const adapter=new SlackAdapter({filesUploadV2:async(args)=>{uploads.push(args);return{files:[{files:[{id:'FFILE'}]}]};}} ,
      {on(){}},'UBOT','fixture');
    const server=new SlackMcplServer(adapter,allowFilePaths?{allowFilePaths:true}:{});
    const h=harness.connectHost(server);
    try{
      await harness.initialize(h,false);
      const tools=await h.host.sendRequest('tools/list',{});
      const upload=tools.tools.find(tool=>tool.name==='upload_file');
      assert.equal(!!upload.inputSchema.properties.path,allowFilePaths);
      const path=join(dir,'fixture.txt');writeFileSync(path,'synthetic fixture');
      const result=await h.host.sendRequest('tools/call',{name:'upload_file',arguments:{channelId:'CONE',path}});
      assert.equal(result.isError===true,!allowFilePaths);
      assert.equal(uploads.length,allowFilePaths?1:0);
      if(allowFilePaths){assert.ok(Buffer.isBuffer(uploads[0].file));assert.equal(uploads[0].file.toString(),'synthetic fixture');}
      results.push({name:allowFilePaths?'explicit bounded local-path opt-in':'default local paths absent and refused',passed:true});
    }finally{await h.close();await adapter.stop();}
  }
  writeFileSync(output,JSON.stringify({node:process.version,results,summary:{passed:results.length,failed:0}},null,2)+'\n');
  console.log(JSON.stringify({node:process.version,passed:results.length,failed:0,report:output}));
}finally{rmSync(dir,{recursive:true,force:true});}
