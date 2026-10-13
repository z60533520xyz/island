// 輸出棋盤 SVG 檔案方便目視檢查：node test/snapshot.mjs <人數> <輸出檔>
import fs from 'node:fs';
import { createGame, viewFor, geo } from '../js/engine.js';

const n = Number(process.argv[2] || 6);
const out = process.argv[3] || `board-${n}p.svg`;
let html = '';
globalThis.document = {
  querySelector: (sel) => (sel === '#board'
    ? { set innerHTML(v) { html = v; }, get innerHTML() { return html; }, setAttribute() {}, addEventListener() {}, classList: { toggle() {} } }
    : { innerHTML: '', classList: { toggle() {} }, dataset: {}, addEventListener() {}, setAttribute() {} }),
  addEventListener() {},
};
const ui = await import('../js/ui.js');
const app = { me: 0, online: [], chat: [], code: 'SNAP', role: 'host', dispatch() {}, modalData: {} };
ui.initUI(app);
const s = createGame(Array.from({ length: n }, (_, i) => ({ name: `P${i}` })));
app.view = viewFor(s, 0);
ui.render();
const b = geo(s).bounds;
const m = 1.3;
const vb = [b.minX - m, b.minY - m, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m].map((x) => Math.round(x * 100)).join(' ');
const css = fs.readFileSync(new URL('../css/style.css', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.startsWith('#board')).join('\n').replaceAll('#board ', '').replaceAll('var(--sea)', '#3a86c8');
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="900"><style>${css}</style>${html}</svg>`);
console.log(`已輸出 ${out}`);
