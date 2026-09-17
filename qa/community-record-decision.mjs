import assert from 'node:assert/strict';
import {decideCommunityRecord} from '../src/community-decision.ts';
import {incomingMessageBody} from '../src/community-intake.ts';

const base={intent:'completion',outcome:'complete',goalText:null,hasReflection:false,needsConfirmation:false};
assert.deepEqual(decideCommunityRecord(base,'완료했어요.'),{intent:'completion',outcome:'complete',goalText:null,reflectionText:null,needsConfirmation:false,currentDateSafe:true});
const narrative='완료. 지난 주에는 미뤘지만 오늘은 끝냈어요. 다음 행동부터 정하는 게 도움이 됐어요.';
assert.deepEqual(decideCommunityRecord(base,narrative),{intent:'completion',outcome:'complete',goalText:null,reflectionText:narrative,needsConfirmation:true,currentDateSafe:true});
assert.equal(decideCommunityRecord({...base,intent:'unclear',outcome:'unknown',needsConfirmation:true},'오늘은 집중하기 어려웠어요.').reflectionText,'오늘은 집중하기 어려웠어요.');
assert.equal(decideCommunityRecord({...base,intent:'reflection',hasReflection:true},narrative).reflectionText,narrative);
assert.equal(decideCommunityRecord({...base,intent:'unclear',outcome:'unknown',needsConfirmation:true},'완료했나요?').reflectionText,null);
assert.equal(decideCommunityRecord({...base,intent:'ignore',outcome:'unknown'},narrative).reflectionText,null);
assert.deepEqual(decideCommunityRecord({...base,intent:'unclear',outcome:'unknown',needsConfirmation:true},'9월 13일 목표를 완료했어요.'),{intent:'unclear',outcome:'unknown',goalText:null,reflectionText:null,needsConfirmation:true,currentDateSafe:false});
assert.equal(decideCommunityRecord({...base,intent:'unclear',outcome:'unknown',needsConfirmation:true},'지난 주 목표를 완료했어요.').currentDateSafe,false);

assert.deepEqual(incomingMessageBody({date:'2026-09-15',thread:'100.000001',rawText:'<@UBOT> 완료. 배웠어요',normalizedText:'완료. 배웠어요',editTs:null,unexpected:'discard me'}),{date:'2026-09-15',thread:'100.000001',rawText:'<@UBOT> 완료. 배웠어요',normalizedText:'완료. 배웠어요',editTs:null});
const bugCanary='BUG_INTAKE_CANARY';
const bugBody=incomingMessageBody({date:'2026-09-15',thread:'100.000002',rawText:bugCanary,normalizedText:bugCanary,editTs:null},{messageType:'bug_intake',contentDigest:'a'.repeat(64)});
assert.deepEqual(bugBody,{date:'2026-09-15',thread:'100.000002',editTs:null,messageType:'bug_intake',contentDigest:'a'.repeat(64)});
assert.equal(JSON.stringify(bugBody).includes(bugCanary),false);
console.log('PASS record decision separates outcome from preserved reflection; ordinary intake stays replayable and bug intake stores digest-only metadata');
