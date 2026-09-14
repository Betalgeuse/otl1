import assert from 'node:assert/strict';import {buildBoard} from '../src/board.ts';import {boardLink,readBoardLink} from '../src/board-link.ts';
const palette={empty:'#EBEDF0',written:'#9BE9A8',complete:'#216E39'};
for(const goals of [[],[{date:'2026-09-12',text:'goal',completed:false}],[{date:'2026-09-13',text:'goal',completed:true}]]){
 const b=buildBoard({startDate:'2026-09-08',palette,goals},'2026-09-14');assert.equal(b.cells.some(c=>c.date==='2026-09-12'),goals.some(g=>g.date==='2026-09-12'));assert.equal(b.cells.some(c=>c.date==='2026-09-13'),goals.some(g=>g.date==='2026-09-13'));assert.ok(b.cells.some(c=>c.date==='2026-09-14'&&c.today));const url=await boardLink(b,{baseUrl:'https://test.example',secret:'test-secret',today:'2026-09-14'});const roundtrip=await readBoardLink(url.split('/board/')[1],'test-secret');assert.deepEqual(roundtrip.cells,b.cells);
}
console.log('PASS empty weekends omitted, participated weekend preserved, Monday remains, signed image roundtrip');
