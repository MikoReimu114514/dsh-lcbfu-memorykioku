/**
 * dsh-lcbf-memory — LCBF+U 长期记忆插件（host 端）
 *
 * L Level   分层：core（永久核心）/ 桶（entity/event/concept）/ cold（冷存储）
 * C Chart   关联：实体双通道建边 + 超级节点降级 + 别名表
 * B Bucket  分桶：实体 75 / 事件 120 / 概念 90（硬截断，溢出进 cold）
 * F Forget  遗忘：权重×衰减 + 保胎（6个月）+ 冷存储压缩 + 双通道复活
 * U Update  更新：dedupe 数字不同=状态更新（覆盖旧值）+ 矛盾失效（supersededBy）
 *
 * 存储：<workspace>/.dsh-lcbf-memory/memory.json（引擎 memory-v2.json 格式）
 * 注入：首轮记忆快照（core + 相关 topN）
 * 工具：memory_lcbf_search / memory_lcbf_remember
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

// 全局记忆 key：所有会话共享（跨会话记忆）
const LCBF_KEY = 'dsh'

export const name = 'lcbf-memory'
export const inject = ['tools']

export async function apply(ctx, config) {
  console.log('[lcbf-memory] APPLY START (apply called)');
  process.stderr.write('[lcbf-memory] APPLY START stderr\n');
  // 绝对路径（DSH 的 cwd 可能是 system32，相对路径会 EPERM）
  const dir = config?.dir ? resolve(config.dir) : (process.env.LCBF_DIR || join(homedir(), '.dsh', 'lcbf-memory'))
  process.env.LCBF_DIR = dir
  mkdirSync(dir, { recursive: true })
  const engine = (await import('./engine.cjs')).default ?? (await import('./engine.cjs'))

  const log = (msg) => { try { ctx.logger?.info?.('[lcbf-memory] ' + msg) } catch { } }
  log('插件加载：存储目录 ' + dir)

  // ---------- 首轮注入（agent/pre-step：带真实用户消息的 enter 时插记忆快照） ----------
  const injectedSessions = new Set()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    let decision
    try { decision = await next() } catch (e) { throw e }
    try {
      if (!decision || decision.kind !== 'enter' || signal?.aborted) return decision
      if (!decision.messages || !decision.messages.length) return decision
      const header = agent?.session?.header
      if (header?.origin === 'subagent') return decision
      const sid = LCBF_KEY
      const userMsgs = decision.messages.filter((m) => m?.source?.kind === 'user')
      if (!userMsgs.length) return decision
      if (injectedSessions.has(sid)) return decision
      const lastText = (() => {
        const c = userMsgs[userMsgs.length - 1]?.content
        if (Array.isArray(c)) return c.map((x) => x?.text || '').join('')
        return String(c || '')
      })()
      const mem = await engine.formatForPromptAsync(sid, lastText)
      if (!mem) { injectedSessions.add(sid); return decision }
      injectedSessions.add(sid)
      const block = {
        id: 'lcbf-mem-' + randomUUID(), // v4: every message needs a non-empty id
        role: 'user',
        source: { kind: 'plugin:lcbf-memory' }, // v4 producer-owned source kind
        content: [{ type: 'text', text: '[长期记忆]\n' + mem }],
      }
      const idx = decision.messages.indexOf(userMsgs[0])
      const messages = [...decision.messages.slice(0, idx), block, ...decision.messages.slice(idx)]
      log('首轮注入：' + mem.length + ' 字（会话 ' + String(sid).slice(0, 8) + '）')
      return { ...decision, messages }
    } catch (e) {
      log('注入失败（fail-open）：' + (e instanceof Error ? e.message : String(e)))
      return decision
    }
  })

  // ---------- condense：对话自动提炼（静默 30 分钟 / 强制 2 小时） ----------
  const pending = new Map(); // sessionId -> { msgs: [{role,text}], lastAt, firstAt }
  const CRED = (() => {
    try {
      const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
      const m = raw.match(/api_?key\s*:\s*['"]?([^'"\s]+)/i);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();
  const extractText = (data) => {
    if (!data) return '';
    if (Array.isArray(data.content)) return data.content.map((x) => x?.text || '').join('');
    return String(data.text || data.content || '');
  };
  ctx.on('session/event', (session, event) => {
    try {
      const sid = session?.id;
      if (!sid) return;
      const t = event?.type;
      if (t !== 'user/message' && t !== 'assistant/message') return;
      const text = extractText(event.data);
      if (!text || text.length < 2) return;
      const s = pending.get(sid) || { msgs: [], lastAt: 0, firstAt: Date.now() };
      s.msgs.push({ role: t.startsWith('user') ? 'user' : 'assistant', text });
      s.lastAt = Date.now();
      pending.set(sid, s);
    } catch (e) { }
  });
  async function condenseNow(sid) {
    const s = pending.get(sid);
    if (!s || !s.msgs.length) return;
    pending.delete(sid);
    const text = s.msgs.slice(-80).map((m) => (m.role === 'user' ? '对方：' : '你：') + String(m.text).slice(0, 500)).join('\n');
    if (!CRED) { log('condense 跳过：没有 API key'); return; }
    try {
      const res = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': CRED, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 4000,
          temperature: 0.1,
          messages: [{ role: 'user', content: '把以下对话提炼成长期记忆条目（JSON数组）。每条：{"text":"一句话事实","bucket":"entity|event|concept","importance":1-10,"event_date":"YYYY-MM-DD"}。event_date=事实发生日期（从对话线索推断，没有用今天）。⭐ 数字/金额/计算结果必须写进 text。只保留值得长期记住的，最多 20 条。只输出JSON数组。\n\n' + text }],
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) { log('condense HTTP ' + res.status); return; }
      const d = await res.json();
      const raw = (d.content || []).map((x) => x.text || '').join('');
      const m = raw.match(/\[[\s\S]*\]/);
      const entries = JSON.parse(m ? m[0] : '[]');
      if (Array.isArray(entries) && entries.length) {
        const r = engine.add(LCBF_KEY, entries, { source: 'condense', createdAt: Date.now() });
        engine.prune(LCBF_KEY);
        engine.save();
        log('condense 写入 ' + (r.added || 0) + ' 条（' + entries.length + ' 提炼）');
      }
    } catch (e) { log('condense 失败：' + (e instanceof Error ? e.message : String(e))); }
  }
  ctx.on('agent/turn-stopping', async () => {
    try {
      const now = Date.now();
      for (const [sid, s] of pending) {
        const quiet = now - s.lastAt;
        const total = now - s.firstAt;
        if (quiet >= 30 * 60000 || total >= 2 * 3600000) await condenseNow(sid);
      }
    } catch (e) { }
  });
  // ---------- 工具：检索 / 记忆写入 ----------
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const searchTool = {
      name: 'memory_lcbf_search',
      description: 'Search long-term memory (LCBF engine). Use when the user asks about past events, preferences, or facts you should remember.',
      parameters: {
        query: { type: 'string', description: 'Search query (keywords or a full question)' },
        k: { type: 'number', description: 'Max results (default 10)' },
      },
      execute: async ({ query, k }, context) => {
        const sid = LCBF_KEY
        try {
          const { picked } = engine.retrieve(sid, String(query || ''), Math.max(1, Math.min(50, Number(k) || 10)))
          return picked.map((m) => {
            const d = m.eventDate ? new Date(m.eventDate).toISOString().slice(0, 10) : '?'
            return '[' + d + '] ' + m.text
          }).join('\n') || '（没有找到相关记忆）'
        } catch (e) { return '检索失败：' + (e instanceof Error ? e.message : String(e)) }
      },
    }
    const rememberTool = {
      name: 'memory_lcbf_remember',
      description: 'Store a long-term memory fact (LCBF engine). Use for stable preferences, important events, or facts worth remembering across sessions.',
      parameters: {
        text: { type: 'string', description: 'One-sentence fact' },
        bucket: { type: 'string', description: 'entity | event | concept' },
        importance: { type: 'number', description: '1-10' },
        event_date: { type: 'string', description: 'YYYY-MM-DD (when the fact happened)' },
      },
      execute: async (args, context) => {
        const sid = LCBF_KEY
        try {
          const r = engine.add(sid, [{
            text: String(args.text || ''),
            bucket: args.bucket || 'event',
            importance: Number(args.importance) || 6,
            event_date: args.event_date,
          }], { source: 'tool' })
          engine.prune(sid)
          return '已记住（' + (r.added || 0) + ' 条）'
        } catch (e) { return '写入失败：' + (e instanceof Error ? e.message : String(e)) }
      },
    }
    const updateTool = {
      name: 'memory_lcbf_update',
      description: 'Update an existing long-term memory: change its text or importance, or archive it. Find by query (fuzzy) — updates the best match.',
      parameters: {
        query: { type: 'string', description: 'Keywords to locate the memory to update' },
        text: { type: 'string', description: 'New text (omit to keep old)' },
        importance: { type: 'number', description: 'New importance 1-10 (omit to keep)' },
        archive: { type: 'boolean', description: 'true = archive (remove from active memory)' },
      },
      execute: async (args) => {
        try {
          const q = String(args.query || '').trim();
          const { picked } = engine.retrieve(LCBF_KEY, q, 10);
          if (!picked.length) return '没找到要更新的记忆';
          // 精确优先：文本包含 query（去空白/小写）；否则列出候选让人确认，避免误更新
          const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
          const exact = picked.filter((x) => norm(x.text).includes(norm(q)));
          if (!exact.length) {
            return '没有精确包含「' + q + '」的记忆。最接近的候选：\n' + picked.slice(0, 3).map((x) => '- ' + String(x.text).slice(0, 80)).join('\n') + '\n请用更精确的关键词重试';
          }
          const m = exact[0];
          if (args.archive) {
            m.validUntil = Date.now();
            m.supersededBy = 'archived-by-user';
          } else {
            if (args.text) m.text = String(args.text);
            if (args.importance) m.importance = Math.max(1, Math.min(10, Number(args.importance)));
          }
          m.updatedAt = Date.now();
          engine.save();
          return '已更新：' + String(m.text).slice(0, 50);
        } catch (e) { return '更新失败：' + (e instanceof Error ? e.message : String(e)) }
      },
    };
    const projectTool = {
      name: 'memory_lcbf_project',
      description: 'Show memories for a project (or a topic): groups by layer (project/lesson/topic/rules) with counts and items.',
      parameters: {
        query: { type: 'string', description: 'Project name or topic keywords' },
        k: { type: 'number', description: 'Max items per layer (default 8)' },
      },
      execute: async (args) => {
        try {
          const k = Math.max(1, Math.min(20, Number(args.k) || 8));
          const { picked } = engine.retrieve(LCBF_KEY, String(args.query || ''), 30);
          const byLayer = {};
          for (const m of picked) {
            const t = (String(m.text).match(/^\[(soul|user|project|fact|lesson|topic|rules)\]/) || [])[1] || '其他';
            (byLayer[t] = byLayer[t] || []).push(m);
          }
          const lines = [];
          for (const [layer, items] of Object.entries(byLayer)) lines.push('[' + layer + '] ' + items.length + ' 条');
          return lines.join('\n') + '\n\n' + picked.slice(0, k).map((m) => '- ' + String(m.text).slice(0, 100)).join('\n');
        } catch (e) { return '查询失败：' + (e instanceof Error ? e.message : String(e)) }
      },
    };
    try { ctx.tools.register(searchTool) } catch (e) { log('search 工具注册失败：' + e.message) }
    try { ctx.tools.register(rememberTool) } catch (e) { log('remember 工具注册失败：' + e.message) }
    try { ctx.tools.register(updateTool) } catch (e) { log('update 工具注册失败：' + e.message) }
    try { ctx.tools.register(projectTool) } catch (e) { log('project 工具注册失败：' + e.message) }
  }

  log('就绪（引擎 v2.2.5 + LCBF+U）')
}

export default { name, inject, apply }
