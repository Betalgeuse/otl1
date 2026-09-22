import assert from 'node:assert/strict';
import { interestReviewCard, interestMemberPromptCard } from '../src/community-interest-admin.ts';
const review = interestReviewCard({ interestId: 'IREQ-TEST1234', revision: 0,
  email: 'a@example.com', displayName: '<@UVICTIM>', intent: 'hello <!channel>',
  knownMemberClue: '', shareNameEmailWithIntroducer: true });
assert.equal(review.channel, 'private');
assert.ok(!JSON.stringify(review).includes('community_invite_approve'));
assert.ok(!JSON.stringify(review).includes('community_invite_mark_invited'));
assert.ok(JSON.stringify(review).includes('community_interest_request'));
assert.ok(!JSON.stringify(review).includes('<@UVICTIM>'));
assert.ok(!JSON.stringify(review).includes('<!channel>'));
const prompt = interestMemberPromptCard({ teamId: 'TTEST', interestId: 'IREQ-TEST1234',
  memberId: 'UMEMBER', revision: 0, nonce: 'A'.repeat(43), expiresAt: Date.now()+3600000,
  displayName: 'Person', email: 'a@example.com' });
assert.ok(JSON.stringify(prompt).includes('community_interest_confirm'));
assert.ok(!JSON.stringify(prompt).includes('approve'));
console.log('INTEREST_ADMIN_CARD=PASS private=1 noApproval=1 escaped=1 memberConfirm=1');
