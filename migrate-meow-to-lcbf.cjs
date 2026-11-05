// migrate-meow-to-lcbf.js — 把 meow-memory 的七层 SQLite 记忆迁到 lcbf 引擎（key='dsh'）
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const MEOW_DB = 'C:/Users/Lenovo/Documents/DSH/.dsh-meow/memory.db';
const LCBF_DIR = 'C:/Users/Lenovo/.dsh/lcbf-memory';
process.env.LCBF_DIR = LCBF_DIR;

const engine = require('C:/Users/Lenovo/Documents/DSH/dsh-lcbf-memory/engine.cjs');
const db = new DatabaseSync(MEOW_DB);

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
const BUCKET = { soul: 'entity', user: 'entity', rules: 'entity', project: 'entity', fact: 'event', lesson: 'concept', topic: 'event' };
const IMP = { soul: 9, user: 9, rules: 9, project: 8, fact: 6, lesson: 7, topic: 7 }; // 强制用层默认（meow 的 importance 不可靠，soul 曾是 4）

const entries = [];
let total = 0;
const stats = {};
for (const t of LEVELS) {
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM ' + t).all();
  } catch (e) { console.log(t, 'skip:', e.message); continue; }
  // 只迁 active 的（stale/archived 跳过；status 缺省视为 active）
  const keep = rows.filter((r) => !r.status || r.status === 'active');
  stats[t] = rows.length + ' 条（active ' + keep.length + '）';
  for (const r of keep) {
    const text = String(r.content || r.title || '').trim();
    if (!text) continue;
    // 长文本截断到 400 字（引擎上限）
    const body = text.length > 400 ? text.slice(0, 400) : text;
    const imp = Math.min(10, Math.max(3, IMP[t] || 6)); // 用层默认，不信 meow 的旧 importance
    const created = Number(r.created_at) || Date.now();
    entries.push({
      text: '[' + t + '] ' + body,
      bucket: BUCKET[t] || 'event',
      importance: imp,
      entities: ['dsh'], // 共同实体：消除孤立惩罚
      event_date: new Date(created).toISOString().slice(0, 10),
    });
  }
}
total = entries.length;
console.log('层级统计:', JSON.stringify(stats));
console.log('待迁移条目:', total);

// 分批 add（避免一次太大）
const KEY = 'dsh';
let added = 0;
for (let i = 0; i < entries.length; i += 50) {
  const chunk = entries.slice(i, i + 50);
  const r = engine.add(KEY, chunk, { source: 'migrate', createdAt: Date.now() });
  added += r.added || 0;
}
engine.prune(KEY);
engine.save();
console.log('已写入 lcbf:', added, '条 | 存储目录:', LCBF_DIR);
const st = engine.state()[KEY];
const all = [...st.core, ...(st.taboo || []), ...st.entity, ...st.event, ...st.concept];
console.log('lcbf 当前:', all.length, '条（core', st.core.length, '| cold', (st.cold || []).length, '）');
