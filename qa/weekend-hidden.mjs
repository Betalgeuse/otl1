import assert from 'node:assert/strict';import {buildBoard} from '../src/board.ts';import {boardLink,readBoardLink} from '../src/board-link.ts';
const palette={empty:'#EBEDF0',written:'#9BE9A8',complete:'#216E39'};
const ladder=[];
const weekdayDate=(ordinal)=>{let stamp=Date.parse('2026-01-05T00:00:00Z'),seen=0;while(true){const date=new Date(stamp).toISOString().slice(0,10);const day=new Date(stamp).getUTCDay();if(day!==0&&day!==6){seen+=1;if(seen===ordinal)return date;}stamp+=86400000;}};
for(const [day,count] of [[1,4],[4,4],[5,8],[8,8],[9,16],[16,16],[17,32],[32,32],[33,33],[64,64]]){const today=weekdayDate(day);const board=buildBoard({startDate:'2026-01-05',palette,goals:[]},today);assert.equal(board.cells.length,count,`eligible day ${day}`);assert.equal(board.cells[0].day,1);assert.equal(board.cells.filter(c=>!c.future).length,day);ladder.push([day,board.cells.length]);}
for(const goals of [[],[{date:'2026-09-12',text:'goal',completed:false}],[{date:'2026-09-13',text:'goal',completed:true}]]){
 const b=buildBoard({startDate:'2026-09-08',palette,goals},'2026-09-14');assert.equal(b.cells.some(c=>c.date==='2026-09-12'),goals.some(g=>g.date==='2026-09-12'));assert.equal(b.cells.some(c=>c.date==='2026-09-13'),goals.some(g=>g.date==='2026-09-13'));assert.ok(b.cells.some(c=>c.date==='2026-09-14'&&c.today));const url=await boardLink(b,{baseUrl:'https://test.example',secret:'test-secret',today:'2026-09-14'});const roundtrip=await readBoardLink(url.split('/board/')[1],'test-secret');assert.deepEqual(roundtrip.cells,b.cells);
}
const kstBoundary=buildBoard({startDate:'2026-09-18',palette,goals:[{date:'2026-09-19',text:'played Saturday',completed:false}]},'2026-09-21');assert.deepEqual(kstBoundary.cells.slice(0,3).map(c=>c.date),['2026-09-18','2026-09-19','2026-09-21']);assert.deepEqual(kstBoundary.cells.slice(0,3).map(c=>c.day),[1,2,4]);
console.log(`GARDEN_LADDER_OBSERVABLES=${JSON.stringify({ladder,weekendDates:kstBoundary.cells.slice(0,3).map(c=>c.date),dayLabels:kstBoundary.cells.slice(0,3).map(c=>c.day)})}`);
console.log('PASS exact 4/8/16/32/+1 ladder, empty weekends hidden, played weekends stable, signed roundtrip');
