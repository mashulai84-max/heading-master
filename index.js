"use strict";

/* =========================================================================
 * 智能标题 Heading Master —— 思源笔记插件
 *
 * 把带中文/数字序号的段落一键转成分级标题，标题混在正文里时自动拆出来。
 *
 * 写入路径（实测）：
 *   /api/block/updateBlock  dataType=markdown   —— 改原块为标题
 *   /api/block/insertBlock  dataType=markdown   —— 追加其余块（倒序 + 同一锚点）
 *   /api/transactions                          —— 不可用：HTTP 调用返回 code 0 但不生效
 *   dataType=dom                               —— 不可用：内核直接断连
 *
 * 回滚：整篇 kramdown 快照，还原用 updateBlock(docId, markdown)。
 * ========================================================================= */

let SY = {};
try {
  SY = require("siyuan");
} catch (e) {
  SY = {};
}
const Plugin = SY.Plugin || class {};
const Dialog = SY.Dialog || null;

/* ---------------------------- 0. 默认配置 ---------------------------- */

const DEFAULT_SETTINGS = {
  levelMode: "auto", // auto | relative | absolute
  splitParagraph: true,
  noSkip: true,
  maxTitleLen: 30,
  snapshot: true,
  // 自定义关键词：每行一个，可写「功效=3」单独指定级别
  customKeywords: "组成\n功效\n主治\n用法\n用法用量\n方解\n应用\n注意事项",
  customLevel: 0, // 0 = 跟随上下文（上一个标题 +1）
  customStrict: true, // 严格：关键词后必须是空格/冒号或段末
  colonMin: 5, // 「短词：正文」至少出现这么多条，才整篇启用
  rules: {
    custom: true,
    colon: true,
    bracket: true,
    chapter: true,
    section: true,
    cnNum: true,
    cnParen: true,
    arNum: true,
    arParen: true,
    circle: true,
    multi: true,
  },
  lastBackup: null,
};

const API = {
  child: "/api/block/getChildBlocks",
  kramdown: "/api/block/getBlockKramdown",
  update: "/api/block/updateBlock",
  insert: "/api/block/insertBlock",
};

const VERSION = "0.4.0";

/* 思源插件存储：saveData(name, data) / loadData(name)，name 必填 */
const SETTINGS_FILE = "settings.json";

/* 顶栏图标：三条递减横杠。不依赖内置图标名，直接写 svg。 */
const TOPBAR_SVG =
  '<svg viewBox="0 0 32 32" width="16" height="16" fill="currentColor" aria-hidden="true">' +
  '<rect x="4" y="6" width="24" height="4.6" rx="2.3"/>' +
  '<rect x="4" y="13.7" width="17" height="4.6" rx="2.3"/>' +
  '<rect x="4" y="21.4" width="11" height="4.6" rx="2.3"/>' +
  "</svg>";

/* ---------------------------- 1. 基础工具 ---------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escMd(s) {
  return String(s || "")
    .replace(/([\\`*_\[\]])/g, "\\$1")
    .replace(/^([#>\-=+])/, "\\$1");
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function apiBase() {
  try {
    if (typeof location !== "undefined" && /^https?:/.test(location.origin || "")) return location.origin;
  } catch (e) {}
  return "http://127.0.0.1:6806";
}

async function api(path, data) {
  const conf = (typeof window !== "undefined" && window.siyuan && window.siyuan.config) || {};
  const token = (conf.api && conf.api.token) || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Token " + token;
  const res = await fetch(apiBase() + path, {
    method: "POST",
    headers,
    body: JSON.stringify(data || {}),
  });
  const txt = await res.text();
  if (!txt) throw new Error("内核无响应：" + path);
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    throw new Error("返回非 JSON：" + path);
  }
  if (json.code !== 0) throw new Error(json.msg || "接口失败：" + path);
  return json.data;
}

/* ---------------------------- 2. 序号识别 ---------------------------- */

const CIRCLES = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };

function cn2num(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      cur = CN_DIGIT[ch];
      seen = true;
    } else if (ch in CN_UNIT) {
      if (cur === 0) cur = 1;
      total += cur * CN_UNIT[ch];
      cur = 0;
      seen = true;
    }
  }
  return seen ? total + cur : NaN;
}

const RULES = [
  { key: "bracket", family: "bracket", level: 3, whole: true, noNum: true, re: /^【([^】\n]{1,24})】[　\s]*/ },
  { key: "chapter", family: "chapter", level: 1, re: /^第\s*([一二三四五六七八九十百千零〇\d]{1,6})\s*(部分|编|篇|章|部|讲)\s*[　\t:：.、]?/ },
  { key: "section", family: "section", level: 2, re: /^第\s*([一二三四五六七八九十百千零〇\d]{1,6})\s*节\s*[　\t:：.、]?/ },
  { key: "cnParen", family: "cnParen", level: 3, re: /^[（(]\s*([一二三四五六七八九十百]{1,4})\s*[）)]\s*/ },
  { key: "cnParen", family: "cnParen", level: 3, re: /^([一二三四五六七八九十百]{1,4})\s*[）)]\s*/ },
  { key: "cnNum", family: "cnNum", level: 2, re: /^([一二三四五六七八九十百]{1,4})\s*[、.．]\s*/ },
  { key: "arParen", family: "arParen", level: 5, re: /^[（(]\s*(\d{1,3})\s*[）)]\s*/ },
  { key: "arParen", family: "arParen", level: 5, re: /^(\d{1,3})\s*[）)]\s*/ },
  { key: "circle", family: "circle", level: 6, re: /^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*/ },
  { key: "multi", family: "multi", level: 0, re: /^(\d{1,3}(?:\.\d{1,2}){1,2})[.．、]?[　\t ]/ },
  { key: "arNum", family: "arNum", level: 4, re: /^(\d{1,3})\s*[、.．]\s*/ },
];

function normDigits(s) {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 在小片段开头识别序号；返回 {key,family,level,len,num} 或 null */
function detectMarker(s) {
  if (!s) return null;
  const full = normDigits(s);
  const head = full.slice(0, 48);
  for (const r of RULES) {
    const m = head.match(r.re);
    if (!m) continue;

    if (r.key === "multi") {
      const segs = m[1].split(".");
      const lastSeg = Number(segs[segs.length - 1]);
      return { key: r.key, family: r.family, level: 1 + segs.length, len: m[0].length, num: lastSeg };
    }
    if (r.key === "arNum") {
      const after = full.slice(m[0].length);
      if (/^\d/.test(after)) continue; // 1.5～1.5g 之类
    }
    if (r.key === "circle") {
      return {
        key: r.key,
        family: r.family,
        level: r.level,
        len: m[0].length,
        num: CIRCLES.indexOf(m[1]) + 1,
        whole: !!r.whole,
        noNum: !!r.noNum,
      };
    }
    return {
      key: r.key,
      family: r.family,
      level: r.level,
      len: m[0].length,
      num: cn2num(m[1]),
      whole: !!r.whole,
      noNum: !!r.noNum,
    };
  }
  return null;
}

const BOUNDARY = /^[。！？；\n　\t：:]$/;

/* --------- 自定义关键词：纯文字小标题（功效 / 应用 / 组成 …） --------- */

let _kwCache = { src: null, list: [] };

/** 解析用户填的关键词串，长词优先（「用法用量」先于「用法」） */
function parseCustomKeywords(src) {
  const out = [];
  const seen = new Set();
  for (let p of String(src || "").split(/[\n\r,，、;；\s]+/)) {
    p = p.trim();
    if (!p) continue;
    let level = 0;
    const m = p.match(/^(.+?)\s*=\s*([1-6])$/);
    if (m) {
      p = m[1].trim();
      level = Number(m[2]);
    }
    p = p.replace(/^【/, "").replace(/】$/, "").trim();
    if (p.length < 2 || seen.has(p)) continue;
    seen.add(p);
    out.push({ word: p, level });
  }
  out.sort((a, b) => b.word.length - a.word.length);
  return out;
}

/** 带缓存的取词表，避免每个字符位置都重新解析 */
function kwList(cfg) {
  const src = String((cfg && cfg.customKeywords) || "");
  if (_kwCache.src === src) return _kwCache.list;
  const list = parseCustomKeywords(src);
  _kwCache = { src, list };
  return list;
}

/**
 * 在片段开头匹配自定义关键词。
 * 严格模式：关键词后必须是全角空格/制表符/冒号，或整段就只剩这几个字。
 * 宽松模式：后面直接跟文字也算，但要求剩余很短且不含句读。
 */
function detectCustom(s, cfg) {
  const kws = kwList(cfg);
  if (!kws.length || !s) return null;
  const strict = cfg.customStrict !== false;

  for (const k of kws) {
    if (!s.startsWith(k.word)) continue;
    const after = s.slice(k.word.length);

    // 段末：整段就是这四个字
    if (!after.trim()) {
      return { key: "custom", family: "custom", level: k.level, len: k.word.length, num: null, whole: true, noNum: true, conf: "high" };
    }
    // 关键词后跟分隔符（全角/半角空格、制表符、冒号）：标题到此为止，后面全是正文
    const sep = /^[\s：:]/.test(after);
    if (sep) {
      return {
        key: "custom",
        family: "custom",
        level: k.level,
        len: k.word.length + 1,
        num: null,
        whole: true,
        noNum: true,
        conf: "high",
      };
    }
    if (strict) continue;

    // 宽松：关键词后面直接粘文字，当作「这一整段是个小标题」
    if (after.length <= 10 && !/[。！？；，,、]/.test(after)) {
      return { key: "custom", family: "custom", level: k.level, len: k.word.length, num: null, whole: false, noNum: true, conf: "mid" };
    }
  }
  return null;
}

/** 段首标记：序号优先，其次自定义关键词 */
function firstMarker(t, cfg) {
  return detectMarker(t.slice(0, 48)) || detectCustom(t.slice(0, 48), cfg);
}

/* --------- 冒号短标题：「口眼喎斜：足跗上放血。」这种无序号小标题 --------- */

/**
 * 抽「短词：正文」结构。冒号前必须是最多 10 个非标点字符，
 * 且不能是数字开头（那是序号，交给 arNum）。
 */
function colonHead(t) {
  const s = String(t || "").replace(/^[\s　]+/, "");
  const m = s.match(/^([^：:\n]{1,10})[：:][ \t　]*(\S[\s\S]*)$/);
  if (!m) return null;
  const head = m[1].trim();
  if (!head) return null;
  if (/[。！？；，、,.!?;（）()【】《》]/.test(head)) return null;
  if (/^\d/.test(head)) return null;
  if (/^(第|附|注|注：)/.test(head) && head.length > 6) return null;
  const body = m[2].trim();
  if (body.length < 2) return null;
  return { head, body };
}

/**
 * 文档级判断：只有同一篇里出现足够多「短词：正文」，才认为这是一批小标题。
 * 零星一两条（如「注意：…」）不动，避免普通文章被误转。
 */
function countColonPattern(blocks, cfg) {
  let n = 0;
  for (const b of blocks) {
    if (normType(b.type) !== "NodeParagraph") continue;
    const t = String(b.text || "").replace(/^[\s　]+/, "");
    if (!t) continue;
    if (detectMarker(t.slice(0, 48)) || detectCustom(t.slice(0, 48), cfg)) continue;
    if (colonHead(t)) n++;
  }
  return n;
}

/**
 * 在一段文字里找出所有"条目起点"。
 * 起点必须落在句末/全角空格/换行/冒号之后，且同族序号递增。
 */
function scanMarkers(text, cfg) {
  const out = [];
  let family = null;
  let lastNum = null;
  for (let i = 0; i < text.length; i++) {
    // 序号必须落在句末/空格/换行/冒号之后；但【】本身就是强标志，出现在句中也可以切
    if (i > 0 && text[i] !== "【" && !BOUNDARY.test(text[i - 1])) continue;

    // 自定义关键词自成一体：不受序号递增链约束，也不会打断序号链
    if (cfg.rules.custom) {
      const cm = detectCustom(text.slice(i, i + 40), cfg);
      if (cm) {
        out.push({ idx: i, m: cm });
        i += cm.len - 1;
        continue;
      }
    }

    const m = detectMarker(text.slice(i));
    if (!m) continue;
    if (!cfg.rules[m.key]) continue;
    if (out.length === 0) {
      family = m.family;
      lastNum = m.num;
      out.push({ idx: i, m });
      i += m.len - 1;
      continue;
    }
    if (m.family !== family) continue;
    if (m.noNum) {
      out.push({ idx: i, m });
      i += m.len - 1;
      continue;
    }
    if (!(m.num > lastNum && m.num - lastNum <= 2)) continue;
    lastNum = m.num;
    out.push({ idx: i, m });
    i += m.len - 1;
  }
  return out;
}

/** 把 "总则　本方为…" 拆成 标题/正文 */
function splitHeadBody(rest, cfg) {
  const s = String(rest || "").replace(/^[\s　]+/, "");
  if (!s) return { title: "", body: "" };

  // 1. 强分隔符：全角空格、制表符、冒号
  let cut = -1;
  let cutLen = 0;
  for (const d of ["　", "\t", "：", ":"]) {
    const i = s.indexOf(d);
    if (i > 0 && (cut < 0 || i < cut)) {
      cut = i;
      cutLen = d.length;
    }
  }
  if (cut > 0 && cut <= cfg.maxTitleLen + 10) {
    return { title: s.slice(0, cut).trim(), body: s.slice(cut + cutLen).trim() };
  }

  // 2. 句末标点
  const m = s.match(/^[^。；！？]{1,40}[。；！？]/);
  if (m && m[0].length <= cfg.maxTitleLen + 1) {
    return { title: m[0].replace(/[。；！？]$/, "").trim(), body: s.slice(m[0].length).trim() };
  }

  // 3. 逗号兜底：标题很短才切（如 "38.甘草干姜汤，炙甘草12克…"）
  const ci = s.search(/[，,]/);
  if (ci > 0 && ci <= Math.min(16, cfg.maxTitleLen)) {
    return { title: s.slice(0, ci).trim(), body: s.slice(ci + 1).trim() };
  }

  return { title: s.trim(), body: "" };
}

function confOf(head, body, via) {
  const len = head.length;
  // 有明确序号前缀的条目，结构本身就是强信号，长度只做轻微降级
  const numbered = !!via && via !== "custom" && via !== "bracket";

  if (numbered) {
    if (body) return len > 34 ? "mid" : "high";
    return len > 40 ? "mid" : "high";
  }

  // 靠自定义关键词 / 方括号 / 猜测得出的标题，字数才真正代表风险
  if (body) {
    if (len > 24) return "low";
    if (len > 16) return "mid";
    return "high";
  }
  if (/[。！？；]$/.test(head)) return "low";
  if (len > 24) return "low";
  if (len > 14) return "mid";
  return "high";
}

/* ---------------------------- 3. 分级 ---------------------------- */

/**
 * 自动模式的核心：用"最近一次标题级别 + 同族记忆"决定层级。
 *  - 第X章/第X节 永远按序号体系走
 *  - 同族连续条目沿用上次级别（一、二、三 都在同一级）
 *  - 更浅的族出现时，把更深的族记忆作废，保证 一、→（一）→二、 能回到原位
 */
function resolveLevel(m, ctx, cfg) {
  const base = ctx.prevLevel || 0;
  let lv;
  let fixed = 0; // 用户显式指定的级别，不受「禁止跳级」压缩

  if (m.key === "custom" || m.key === "colon") {
    fixed = m.key === "custom" ? m.level || Number(cfg.customLevel) || 0 : 0;
    if (fixed > 0) {
      lv = clamp(fixed, 1, 6);
      fixed = lv;
    } else {
      // 跟随上下文：同族沿用上次级别，上下文变浅时重新计算
      const rem = ctx.familyLevel[m.family];
      if (!base) lv = 2;
      else if (rem && base >= rem - 1) lv = rem;
      else lv = base + 1;
    }
  } else if (m.key === "chapter") {
    lv = 1;
  } else if (m.key === "section") {
    lv = 2;
  } else if (cfg.levelMode === "absolute") {
    lv = clamp(m.level, 1, 6);
  } else {
    const remembered = ctx.familyLevel[m.family];
    if (remembered) {
      lv = remembered;
    } else if (cfg.levelMode === "relative") {
      lv = clamp(base + 1, 1, 6);
    } else {
      lv = m.level > base ? m.level : base + 1;
      // 文档里一个上级标题都没有时（整篇就是一堆 "1.xxx"），最浅落到 H2
      if (base === 0) lv = Math.min(lv, 2);
    }
  }

  // 不跳级：最多比上一个标题深一级（H2 下面直接来 "1." 不再跳到 H4）
  // 绝对模式下不生效——那个模式的语义就是"序号决定一切"；用户写死的级别也不压缩
  if (cfg.noSkip && cfg.levelMode !== "absolute" && !fixed && base > 0 && lv > base + 1) lv = base + 1;
  lv = clamp(lv, 1, 6);

  ctx.familyLevel[m.family] = lv;
  for (const k of Object.keys(ctx.familyLevel)) {
    if (k !== m.family && ctx.familyLevel[k] > lv) delete ctx.familyLevel[k];
  }
  ctx.prevLevel = lv;
  return lv;
}

/* ---------------------------- 4. 规划 ---------------------------- */

/** 列表块：把每个条目当作一条待转换文本，整块重建 */
function buildListPlan(block, ctx, cfg) {
  if (block.nested || block.complex) return null;
  const outputs = [];
  let conf = "high";
  for (const it of block.items || []) {
    const composed = String(it.marker || "") + String(it.text || "");
    const m = firstMarker(composed, cfg);
    if (m && cfg.rules[m.key]) {
      const markerText = composed.slice(0, m.len);
      const rest = composed.slice(m.len);
      let head;
      let body;
      if (m.whole) {
        head = markerText.trim().replace(/[：:]$/, "").trim();
        body = rest.trim();
      } else {
        const sb = splitHeadBody(rest, cfg);
        const joiner = /\s$/.test(markerText) ? " " : "";
        head = markerText.replace(/\s+$/, "") + (joiner && sb.title ? " " : "") + sb.title;
        body = sb.body;
      }
      const level = resolveLevel(m, ctx, cfg);
      const c = m.conf || confOf(head, body, m.key);
      if (c === "low") conf = "low";
      else if (c === "mid" && conf === "high") conf = "mid";
      outputs.push({ kind: "h", text: head, level });
      if (body) outputs.push({ kind: "p", text: body.replace(/\n+/g, " ").trim() });
    } else if (String(it.text || "").trim()) {
      outputs.push({ kind: "p", text: String(it.text).trim() });
    }
  }
  if (!outputs.some((o) => o.kind === "h")) return null;
  return {
    blockId: block.id,
    src: (block.items || []).map((it) => it.marker + " " + it.text).join(" ⏎ "),
    marks: false,
    outputs,
    conf,
    via: "list",
    isList: true,
  };
}

function buildPlan(block, ctx, cfg) {
  const raw = String(block.text || "").replace(/\u200b/g, "");
  if (!raw.trim()) return null;
  const t = raw.replace(/^[\s　]+/, "");

  const first = firstMarker(t, cfg);
  const enabled = first && cfg.rules[first.key];

  // 不拆分：只处理"整段本来就像个标题"的块
  // 自定义关键词例外——它本身就是标题与正文的分界，不切就没有意义
  if (!cfg.splitParagraph && !(first && first.key === "custom")) {
    if (!enabled) return null;
    // 关掉拆段时，绝不能把"标题：正文"整段吞成一个标题，
    // 只接受短且没有分隔符的纯标题（如「1.口眼喎斜」）
    if (/[　\t：:]/.test(t)) return null;
    if (t.length > Math.min(16, cfg.maxTitleLen)) return null;
    const level = resolveLevel(first, ctx, cfg);
    return {
      blockId: block.id,
      src: raw,
      marks: block.marks,
      outputs: [{ kind: "h", text: t, level }],
      conf: confOf(t, "", first.key),
      via: first.key,
    };
  }

  const marks = scanMarkers(t, cfg);
  if (!marks.length) {
    // 整篇都是「短词：正文」结构时，这一条也按小标题处理
    if (cfg.__colon) {
      const ch = colonHead(t);
      if (ch) {
        const level = resolveLevel({ key: "colon", family: "colon", level: 0, num: null }, ctx, cfg);
        return {
          blockId: block.id,
          src: raw,
          marks: block.marks,
          outputs: [
            { kind: "h", text: ch.head, level },
            { kind: "p", text: ch.body.replace(/\n+/g, " ").trim() },
          ],
          conf: "mid",
          via: "colon",
        };
      }
    }
    return null;
  }

  const outputs = [];

  // 序号前面还有正文 → 先留一段普通段落
  if (marks[0].idx > 0) {
    const lead = t.slice(0, marks[0].idx).trim();
    if (lead) outputs.push({ kind: "p", text: lead });
  }

  let conf = "high";
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].idx;
    const end = k + 1 < marks.length ? marks[k + 1].idx : t.length;
    const chunk = t.slice(start, end);
    const m = marks[k].m;
    const markerText = chunk.slice(0, m.len);
    const rest = chunk.slice(m.len);
    let head;
    let body;
    if (m.whole) {
      // 【药性】/自定义关键词这类：标记本身就是标题，后面全部算正文，不再按句号切
      head = markerText.trim().replace(/[：:]$/, "").trim();
      body = rest.trim();
    } else {
      const sb = splitHeadBody(rest, cfg);
      const joiner = /\s$/.test(markerText) ? " " : "";
      head = markerText.replace(/\s+$/, "") + (joiner && sb.title ? " " : "") + sb.title;
      body = sb.body;
    }
    const level = resolveLevel(m, ctx, cfg);
    const c = m.conf || confOf(head, body, m.key);
    if (c === "low") conf = "low";
    else if (c === "mid" && conf === "high") conf = "mid";
    outputs.push({ kind: "h", text: head, level });
    if (body) outputs.push({ kind: "p", text: body.replace(/\n+/g, " ").trim() });
  }

  if (!outputs.some((o) => o.kind === "h")) return null;

  return {
    blockId: block.id,
    src: raw,
    marks: block.marks,
    outputs,
    conf,
    via: marks.length ? marks[0].m.key : "",
  };
}

function normType(t) {
  if (t === "p") return "NodeParagraph";
  if (t === "h") return "NodeHeading";
  return t || "";
}

/** 按文档顺序走一遍；onlyIds 给定时只收集这些块的计划，但上下文照常推进 */
function buildPlans(blocks, cfg, onlyIds) {
  const ctx = { prevLevel: 0, familyLevel: {} };
  const plans = [];

  // 冒号短标题要整篇一起看：同一篇里够多才启用，零星「注意：…」不动
  const colonN = cfg.rules.colon ? countColonPattern(blocks, cfg) : 0;
  const need = Number(cfg.colonMin) || 5;
  const c = colonN >= need ? Object.assign({}, cfg, { __colon: true, __colonN: colonN }) : cfg;

  for (const b of blocks) {
    const type = normType(b.type);
    if (type === "NodeHeading") {
      ctx.prevLevel = b.level || 1;
      ctx.familyLevel = {};
      continue;
    }
    if (type !== "NodeParagraph" && type !== "NodeList") continue;
    const plan = type === "NodeList" ? buildListPlan(b, ctx, c) : buildPlan(b, ctx, c);
    if (!plan) continue;
    if (onlyIds && !onlyIds.has(plan.blockId)) continue;
    plans.push(plan);
  }
  return plans;
}

/* ---------------------------- 5. 写入 ---------------------------- */

function mdOf(o) {
  const text = escMd(o.text);
  return o.kind === "h" ? "#".repeat(o.level) + " " + text : text;
}

async function applyPlans(plans, onProgress) {
  const errors = [];
  let done = 0;
  for (const plan of plans) {
    const outs = plan.outputs.filter((o) => String(o.text || "").trim());
    if (!outs.length) continue;
    try {
      await api(API.update, { id: plan.blockId, dataType: "markdown", data: mdOf(outs[0]) });
      for (let i = outs.length - 1; i >= 1; i--) {
        await api(API.insert, { previousID: plan.blockId, dataType: "markdown", data: mdOf(outs[i]) });
      }
    } catch (e) {
      errors.push({ id: plan.blockId, msg: String((e && e.message) || e) });
    }
    done += 1;
    if (onProgress) onProgress(done, plans.length);
    if (done % 30 === 0) await sleep(30);
  }
  return errors;
}

/* ---------------------------- 5.1 调整已有标题层级 ---------------------------- */

/** 收集文档里所有标题块；to 是待改的目标级别，初始等于原级别 */
function headingList(blocks) {
  const out = [];
  for (const b of blocks) {
    if (normType(b.type) !== "NodeHeading") continue;
    const lv = clamp(b.level || 1, 1, 6);
    out.push({ id: b.id, text: b.text, raw: b.raw || b.text, level: lv, to: lv });
  }
  return out;
}

/** 按序号规则整篇重算（没有序号前缀的标题保持原级，并重置上下文） */
function relevelHeadings(list, cfg) {
  const ctx = { prevLevel: 0, familyLevel: {} };
  return list.map((h) => {
    const m = firstMarker(String(h.text || ""), cfg);
    if (!m) {
      ctx.prevLevel = h.level;
      ctx.familyLevel = {};
      return h.level;
    }
    return resolveLevel(m, ctx, cfg);
  });
}

/** 批量改写标题级别 */
async function applyLevels(items, onProgress) {
  const errors = [];
  let done = 0;
  for (const it of items) {
    const body = String(it.raw || it.text || "").replace(/\s+$/, "");
    const md = "#".repeat(clamp(it.to, 1, 6)) + " " + body;
    try {
      await api(API.update, { id: it.id, dataType: "markdown", data: md });
    } catch (e) {
      errors.push({ id: it.id, msg: String((e && e.message) || e) });
    }
    done += 1;
    if (onProgress) onProgress(done, items.length);
    if (done % 30 === 0) await sleep(30);
  }
  return errors;
}

/* ---------------------------- 6. DOM 读取 ---------------------------- */

function isVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/**
 * 找到当前活动的编辑器。
 * 注意：3.8.x 的 .protyle-wysiwyg 上没有 data-doc-id（前端代码里确认过），
 * 文档 ID 要从 .protyle-title[data-node-id] 上取。
 */
function activeEditor() {
  const cands = [];
  for (const el of document.querySelectorAll(".protyle")) {
    if (!isVisible(el)) continue;
    const w = el.querySelector(".protyle-wysiwyg");
    if (!w) continue;
    let docId = "";
    const title = el.querySelector(".protyle-title[data-node-id]");
    if (title) docId = title.getAttribute("data-node-id") || "";
    if (!docId) {
      const alt = el.querySelector('[data-type="NodeDocument"][data-node-id]');
      if (alt) docId = alt.getAttribute("data-node-id") || "";
    }
    if (!docId) docId = w.getAttribute("data-doc-id") || "";
    cands.push({
      el,
      w,
      docId,
      n: w.querySelectorAll("[data-node-id]").length,
      focused: !!(document.activeElement && el.contains(document.activeElement)),
    });
  }

  if (!cands.length) {
    // 退一步：直接找内容区
    const wys = Array.from(document.querySelectorAll(".protyle-wysiwyg")).filter(isVisible);
    if (!wys.length) return null;
    const ae0 = document.activeElement;
    const w = (ae0 && wys.find((el) => el.contains(ae0))) || wys[wys.length - 1];
    console.info("[heading-master] 未找到 .protyle 容器，直接使用 .protyle-wysiwyg");
    return {
      protyle: w,
      wysiwyg: w,
      docId: w.getAttribute("data-doc-id") || "",
      info: "无 .protyle 容器，退回 wysiwyg；块数 " + w.querySelectorAll("[data-node-id]").length,
    };
  }

  // 先看焦点在谁身上（点顶栏时谁都没有焦点），再看谁的块多（避免抓到只有标题的悬浮预览）
  cands.sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || b.n - a.n);
  const pick = cands[0];

  return {
    protyle: pick.el,
    wysiwyg: pick.w,
    docId: pick.docId,
    info: `编辑区 ${cands.length} 个，块数 [${cands.map((c) => c.n).join(",")}]，选中 ${pick.n} 块的那一个`,
  };
}

const BLOCK_ID_RE = /^\d{14}-[a-z0-9]{7}$/;

/**
 * 取块内纯文本。
 * 不依赖 contenteditable / 内层 div 结构，只跳过 UI 附属节点，
 * 这样思源怎么改 DOM 包装都能取到字。
 */
function blockTextOf(el) {
  let out = "";
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const cl = n.classList;
      if (cl && (cl.contains("protyle-attr") || cl.contains("protyle-action") || cl.contains("protyle-icons"))) continue;
      if (n.tagName === "BR") {
        out += "\n";
        continue;
      }
      walk(n);
    }
  };
  walk(el);
  return out;
}

function stripInline(s) {
  return String(s || "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/^\s*#{1,6}\s+/, "");
}

/**
 * 把整篇 kramdown 切成块。
 * 比 DOM 稳（不受渲染进度影响），比 SQL 稳（不受索引延迟影响），一次请求拿全篇。
 */
function parseKramdown(md) {
  const blocks = [];
  const chunks = String(md || "").split(/\n\s*\n/);
  for (const raw of chunks) {
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let id = "";
    let attrs = "";
    let contentLines = lines;
    const last = lines[lines.length - 1];
    const mAttr = last.match(/^\{:\s*(.*)\}\s*$/);
    if (mAttr) {
      attrs = mAttr[1];
      contentLines = lines.slice(0, -1);
      const mi = attrs.match(/id="([^"]+)"/);
      if (mi) id = mi[1];
    }
    if (!id) continue;

    const text = contentLines.join("\n");
    const firstLine = (contentLines[0] || "").trim();

    // 列表块：一个块里含多个条目，条目 id 内嵌在行首标记之后
    if (/^([-*+]|\d+[.)])\s/.test(firstLine)) {
      const items = [];
      let nested = false;
      let complex = false;
      for (const line of contentLines) {
        const mLi = line.match(/^([ \t]*)([-*+]|\d+[.)])\s*(?:\{:\s*id="[^"]+"[^}]*\}\s*)?(.*)$/);
        if (mLi) {
          if (mLi[1].length >= 2) nested = true;
          items.push({ marker: mLi[2], text: stripInline(mLi[3]) });
          continue;
        }
        if (/^\{:\s*.*\}\s*$/.test(line.trim())) continue;
        complex = true; // 有跨行续写，结构不确定，宁可不碰
      }
      blocks.push({
        el: null,
        id,
        type: "NodeList",
        level: 0,
        text: items.map((it) => it.marker + " " + it.text).join("\n"),
        marks: false,
        items,
        nested,
        complex,
      });
      continue;
    }

    let type = "NodeParagraph";
    let level = 0;
    const mh = firstLine.match(/^(#{1,6})\s+/);
    if (mh) {
      type = "NodeHeading";
      level = mh[1].length;
    } else if (/^[-*+]\s/.test(firstLine) || /^\d+[.)]\s/.test(firstLine)) {
      type = "NodeListItem";
    } else if (/^\|/.test(firstLine)) {
      type = "NodeTable";
    } else if (/^>/.test(firstLine)) {
      type = "NodeBlockquote";
    } else if (/^```/.test(firstLine)) {
      type = "NodeCodeBlock";
    }
    if (/type="doc"/.test(attrs)) type = "NodeDocument";

    blocks.push({
      el: null,
      id,
      type,
      level,
      text: stripInline(text),
      // 标题的原始内联 markdown（去掉 ### 前缀），改级别时用它写回，保住加粗/链接
      raw: mh ? text.replace(/^#{1,6}\s+/, "") : text,
      marks: /\*\*|~~|==|`/.test(text),
    });
  }
  return blocks;
}

function blockTypeOf(el) {
  const t = el.getAttribute("data-type");
  if (t) return t;
  const cl = el.classList;
  if (cl.contains("p")) return "NodeParagraph";
  for (let i = 1; i <= 6; i++) if (cl.contains("h" + i)) return "NodeHeading";
  return "";
}

function blockLevelOf(el) {
  const sub = el.getAttribute("data-subtype") || "";
  if (/^h[1-6]$/.test(sub)) return Number(sub[1]);
  for (let i = 1; i <= 6; i++) if (el.classList.contains("h" + i)) return i;
  return 0;
}

function blockIdOf(el) {
  const id = el.getAttribute("data-node-id");
  if (id) return id;
  const a = el.getAttribute("id") || "";
  if (BLOCK_ID_RE.test(a)) return a;
  const b = el.getAttribute("data-id") || "";
  if (BLOCK_ID_RE.test(b)) return b;
  return "";
}

function hasMarks(el) {
  if (el.querySelector("strong,b,em,i,code,a,mark,u,s,sup,sub,kbd")) return true;
  for (const n of el.querySelectorAll("[data-type]")) {
    const t = n.getAttribute("data-type") || "";
    if (/^(strong|em|code|link|tag|block-ref|mark|u|s|sup|sub|inline-math|kbd|text)$/.test(t)) {
      if (t !== "text") return true;
    }
  }
  return false;
}

function isTopLevel(el, root) {
  let p = el.parentElement;
  while (p && p !== root) {
    if (p.hasAttribute && p.hasAttribute("data-node-id")) return false;
    p = p.parentElement;
  }
  return p === root;
}

/**
 * 有些版本会把块再包一层带 data-node-id 的壳（壳上没有 data-type）。
 * 壳子会被当成"顶层块"，真块反而被 isTopLevel 排除掉。
 * 这里向下剥壳，直到拿到真正带类型的块。
 */
function unwrapBlock(el) {
  let cur = el;
  for (let k = 0; k < 4; k++) {
    if (cur.getAttribute("data-type")) return cur;
    const kids = Array.from(cur.children).filter((c) => c.hasAttribute && c.hasAttribute("data-node-id"));
    if (kids.length !== 1) return cur;
    cur = kids[0];
  }
  return cur;
}

function topBlocks(root) {
  return Array.from(root.querySelectorAll("[data-node-id]"))
    .filter((el) => isTopLevel(el, root))
    .map(unwrapBlock);
}

function parseBlock(el) {
  return {
    el,
    id: blockIdOf(el),
    type: blockTypeOf(el),
    level: blockLevelOf(el),
    text: blockTextOf(el).replace(/\u200b/g, ""),
    marks: hasMarks(el),
  };
}

/* ---------------------------- 7. 界面 ---------------------------- */

const LEVELS = [1, 2, 3, 4, 5, 6];

function renderRow(plan, idx, checked) {
  const headLevel = (plan.outputs.find((o) => o.kind === "h") || {}).level || 2;
  const opts = LEVELS.map((n) => `<option value="${n}"${n === headLevel ? " selected" : ""}>H${n}</option>`).join("");

  const chips = plan.outputs
    .filter((o) => String(o.text || "").trim())
    .map((o) =>
      o.kind === "h"
        ? `<span class="hm-chip hm-chip--h" data-chip="h"><span class="hm-lvnum">H${o.level}</span> ${escHtml(truncate(o.text, 40))}</span>`
        : `<span class="hm-chip hm-chip--p">正文 ${escHtml(truncate(o.text, 22))}</span>`
    )
    .join("");

  const warns = [];
  if (plan.marks) warns.push("含行内格式");
  if (plan.conf === "low") warns.push("疑似正文");
  if (plan.conf === "mid") warns.push(plan.via === "custom" ? "宽松匹配" : plan.via === "colon" ? "推断标题" : "标题偏长");

  return `<div class="hm-item${checked ? "" : " hm-item--off"}" data-idx="${idx}">
    <input type="checkbox" class="hm-check" ${checked ? "checked" : ""}>
    <div class="hm-main">
      <div class="hm-src" title="${escHtml(plan.src)}">${escHtml(truncate(plan.src, 90))}</div>
      <div class="hm-out">${chips}${warns.map((w) => `<span class="hm-warn">${escHtml(w)}</span>`).join("")}</div>
    </div>
    <select class="b3-select hm-level" data-idx="${idx}">${opts}</select>
  </div>`;
}

function cfgInnerHtml() {
  return `
    <label class="hm-cfg__row">分级策略
      <select class="b3-select" data-cfg="levelMode">
        <option value="auto">自动（序号体系 + 上下文兜底）</option>
        <option value="relative">相对上下文（当前层级 +1）</option>
        <option value="absolute">绝对（一、永远是 H2）</option>
      </select>
    </label>
    <label class="hm-cfg__row">自动拆分段落 <input type="checkbox" data-cfg="splitParagraph"></label>
    <label class="hm-cfg__row">禁止跳级 <input type="checkbox" data-cfg="noSkip"></label>
    <label class="hm-cfg__row">标题最长字数 <input class="b3-text-field" type="number" min="8" max="60" step="1" data-cfg="maxTitleLen"></label>
    <label class="hm-cfg__row">转换前存快照 <input type="checkbox" data-cfg="snapshot"></label>
    <div class="hm-cfg__custom">
      <div class="hm-cfg__ctitle">
        自定义关键词
        <span class="hm-hint">纯文字小标题。每行一个，可写「功效=3」指定级别；建议 2 字以上</span>
      </div>
      <textarea class="b3-text-field hm-kw" data-cfg="customKeywords" rows="3" spellcheck="false" placeholder="组成&#10;功效&#10;主治=3&#10;用法用量"></textarea>
      <div class="hm-cfg__kwopts">
        <label><input type="checkbox" data-rule="custom">启用</label>
        <label>默认级别
          <select class="b3-select" data-cfg="customLevel">
            <option value="0">跟随上下文</option>
            <option value="1">H1</option>
            <option value="2">H2</option>
            <option value="3">H3</option>
            <option value="4">H4</option>
            <option value="5">H5</option>
            <option value="6">H6</option>
          </select>
        </label>
        <label><input type="checkbox" data-cfg="customStrict">严格（词后需空格/冒号）</label>
      </div>
    </div>
    <div class="hm-cfg__rules">
      <label><input type="checkbox" data-rule="bracket">【标签】</label>
      <label><input type="checkbox" data-rule="colon">冒号标题</label>
      <label><input type="checkbox" data-rule="chapter">第X章/编</label>
      <label><input type="checkbox" data-rule="section">第X节</label>
      <label><input type="checkbox" data-rule="cnNum">一、</label>
      <label><input type="checkbox" data-rule="cnParen">（一）</label>
      <label><input type="checkbox" data-rule="arNum">1.</label>
      <label><input type="checkbox" data-rule="arParen">（1）</label>
      <label><input type="checkbox" data-rule="circle">①</label>
      <label><input type="checkbox" data-rule="multi">1.1</label>
    </div>`;
}

function statHtml(plans) {
  const totalHead = plans.reduce((n, p) => n + p.outputs.filter((o) => o.kind === "h").length, 0);
  const totalPara = plans.reduce((n, p) => n + p.outputs.filter((o) => o.kind === "p").length, 0);
  const risky = plans.filter((p) => p.conf !== "high").length;
  return `识别 <b>${plans.length}</b> 个段落 → <b>${totalHead}</b> 个标题${
    totalPara ? ` + <b>${totalPara}</b> 段正文` : ""
  }${risky ? `　<span class="hm-warn">${risky} 条待确认</span>` : ""}`;
}

function listHtml(plans) {
  if (!plans.length) {
    return '<div class="hm-empty">这篇文档里没找到可转换的段落。<br>可在「规则」里放宽条件，或检查段落是否以「一、」「1.」这类序号开头。<br>纯文字小标题（如「功效　发汗解表」）请在「自定义关键词」里填写。</div>';
  }
  return plans.map((p, i) => renderRow(p, i, p.conf !== "low")).join("");
}

/* ---------- 调整标题层级面板 ---------- */

function levelRowHtml(h, idx) {
  const pad = (clamp(h.level, 1, 6) - 1) * 14 + 6;
  const opts = LEVELS.map((n) => `<option value="${n}"${n === h.to ? " selected" : ""}>H${n}</option>`).join("");
  return `<div class="hm-hrow${h.to !== h.level ? " hm-hrow--chg" : ""}" data-idx="${idx}" style="padding-left:${pad}px">
    <span class="hm-hcur">H${h.level}</span>
    <span class="hm-htxt" title="${escHtml(h.text)}">${escHtml(truncate(h.text, 90))}</span>
    <select class="b3-select hm-hsel" data-idx="${idx}">${opts}</select>
  </div>`;
}

function levelDialogHtml(list) {
  const rows = list.map((h, i) => levelRowHtml(h, i)).join("");
  return `<div class="hm-root">
  <div class="hm-bar">
    <div class="hm-stat hm-lstat"></div>
    <div class="hm-tools">
      <button class="b3-button b3-button--outline b3-button--small" data-act="up">全部 +1</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="down">全部 -1</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="rule">按序号重排</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="reset">恢复</button>
    </div>
  </div>
  <div class="hm-list hm-outline">${rows || '<div class="hm-empty">这篇文档里没有标题块。</div>'}</div>
  <div class="hm-foot">
    <div class="hm-progress"></div>
    <div class="hm-foot__btns">
      <button class="b3-button b3-button--cancel" data-act="cancel">取消</button>
      <button class="b3-button b3-button--text" data-act="apply">应用</button>
    </div>
  </div>
</div>`;
}

function dialogHtml(plans) {
  return `<div class="hm-root">
  <div class="hm-bar">
    <div class="hm-stat">${statHtml(plans)}</div>
    <div class="hm-tools">
      <button class="b3-button b3-button--outline b3-button--small" data-act="all">全选</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="none">清空</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="safe">仅高置信</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="levels">调整层级</button>
      <button class="b3-button b3-button--outline b3-button--small" data-act="cfg">规则</button>
    </div>
  </div>
  <div class="hm-cfg hm-hidden">${cfgInnerHtml()}</div>
  <div class="hm-list">${listHtml(plans)}</div>
  <div class="hm-miss hm-hidden"></div>
  <div class="hm-foot">
    <div class="hm-progress"></div>
    <div class="hm-foot__btns">
      <button class="b3-button b3-button--cancel" data-act="cancel">取消</button>
      <button class="b3-button b3-button--text" data-act="apply" ${plans.length ? "" : "disabled"}>应用</button>
    </div>
  </div>
</div>`;
}

function showDialog({ title, width, height, content }) {
  if (Dialog) {
    const d = new Dialog({ title, content, width, height });
    return {
      el: d.element.querySelector(".hm-root"),
      destroy: () => {
        try {
          d.destroy();
        } catch (e) {}
      },
    };
  }
  const wrap = document.createElement("div");
  wrap.className = "b3-dialog b3-dialog--open";
  wrap.style.zIndex = "68";
  wrap.innerHTML = `<div class="b3-dialog__scrim"></div>
    <div class="b3-dialog__container" style="width:${width};height:${height};max-width:96vw;max-height:92vh;display:flex;flex-direction:column;">
      <div class="b3-dialog__header">${escHtml(title)}</div>
      <div class="b3-dialog__body" style="flex:1;overflow:auto;">${content}</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => {
    if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
  };
  wrap.querySelector(".b3-dialog__scrim").addEventListener("click", close);
  return { el: wrap.querySelector(".b3-dialog__body"), destroy: close };
}

/* ---------------------------- 8. 插件主体 ---------------------------- */

class HeadingMaster extends Plugin {
  async onload() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      const saved = await this.loadData(SETTINGS_FILE);
      if (saved && typeof saved === "object") {
        Object.assign(this.settings, saved);
        this.settings.rules = Object.assign({}, DEFAULT_SETTINGS.rules, saved.rules || {});
      }
    } catch (e) {}

    this.i18nMap = (this.i18n && this.i18n.zh_CN) || this.i18n || {};

    // 集市卡片上的齿轮，只在插件实例存在 setting 时出现；点它走 openSetting()
    this.setting = this.createSettingShim();

    this.injectStyle();

    const bar = this.addTopBar({
      icon: TOPBAR_SVG,
      title: this.t("pluginName", "智能标题"),
      position: "right",
      callback: () => this.openPanel("doc"),
    });
    if (bar) {
      // 不依赖内置图标名（3.8.x 只有 iconH1~iconH6，没有 iconH），直接塞自己的 svg
      bar.innerHTML = TOPBAR_SVG;
      bar.setAttribute("aria-label", this.t("pluginName", "智能标题"));
      bar.setAttribute("title", this.t("pluginName", "智能标题"));
    }

    this.addCommand({ langKey: "convertDoc", hotkey: "", callback: () => this.openPanel("doc") });
    this.addCommand({ langKey: "levelAdjust", hotkey: "", callback: () => this.openLevelPanel("doc") });
    this.addCommand({ langKey: "undoLast", hotkey: "", callback: () => this.undoLast() });

    this.onBlockIconBound = this.onBlockIcon.bind(this);
    this.eventBus.on("click-blockicon", this.onBlockIconBound);
  }

  onunload() {
    if (this.onBlockIconBound) {
      this.eventBus.off("click-blockicon", this.onBlockIconBound);
    }
  }

  t(key, fallback) {
    const v = this.i18nMap && this.i18nMap[key];
    return v || fallback || key;
  }

  toast(msg, timeout) {
    if (typeof SY.showMessage === "function") {
      SY.showMessage(msg, timeout || 4000);
    } else {
      console.log("[heading-master]", msg);
    }
  }

  /** 一个都没识别到时，把扫描情况摊开，方便定位是"没文字"还是"类型不对" */
  reportEmpty(all, onlyIds, extra) {
    const meta = extra || {};
    const stat = {};
    let withText = 0;
    let para = 0;
    let firstPara = null;
    for (const b of all) {
      const k = b.type || "(空类型)";
      stat[k] = (stat[k] || 0) + 1;
      const has = !!String(b.text || "").trim();
      if (has) withText++;
      if (b.type === "NodeParagraph") {
        para++;
        if (has && !firstPara) firstPara = b;
      }
    }
    const detail = Object.keys(stat).map((k) => k + "×" + stat[k]).join(" ");
    console.info("[heading-master] 扫描结果", {
      ver: VERSION,
      source: meta.src,
      editor: meta.info,
      total: all.length,
      withText,
      para,
      detail,
      onlyIds: onlyIds ? onlyIds.size : "全篇",
    });
    console.info("[heading-master] 前 8 块", all.slice(0, 8).map((b) => ({ type: b.type, id: b.id, text: String(b.text || "").slice(0, 40) })));

    let msg = `[v${VERSION}/${meta.src || "?"}] 共 ${all.length} 块（${detail}），有文字 ${withText}，段落 ${para}`;
    if (!withText) msg += "。读不到文字";
    else if (!para) msg += "。没有段落块";
    else if (firstPara) msg += `。首段：「${String(firstPara.text).trim().slice(0, 28)}」`;
    msg += "。若小标题是纯文字（如「功效」），在「规则 → 自定义关键词」里补充";
    this.toast(msg, 12000);
  }

  /** 一次请求拿整篇 kramdown，自己切块——不依赖 DOM 结构，也不依赖 SQL 索引 */
  async loadBlocksFromKramdown(docId) {
    if (!docId) return [];
    const r = await api(API.kramdown, { id: docId });
    return parseKramdown((r && r.kramdown) || "");
  }

  /** 兜底：DOM 上拿不到文档 ID 时，用 SQL 从任意块反查 root_id */
  async resolveDocId(blockId) {
    if (!blockId || !/^\d{14}-/.test(blockId)) return "";
    try {
      const rows = await api("/api/query/sql", {
        stmt: "SELECT root_id AS rootId FROM blocks WHERE id = '" + blockId.replace(/'/g, "") + "'",
      });
      if (Array.isArray(rows) && rows[0]) return rows[0].rootId || "";
    } catch (e) {}
    return "";
  }

  /** 显式挂上样式，不依赖加载器是否自动注入 index.css */
  injectStyle() {
    const id = "heading-master-style";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = "/plugins/" + encodeURIComponent(this.name || "heading-master") + "/index.css";
    document.head.appendChild(link);
  }

  /** 集市齿轮 → 走这里（基类也是调 this.setting.open，这里显式覆写更稳） */
  openSetting() {
    this.openSettingsPanel();
  }

  /**
   * 集市靠"插件实例有没有 setting"来决定显不显示齿轮。
   * 能用真的 Setting 就用真的（兼容 instanceof 判断），并把 open 指向我们的面板；
   * 拿不到就退化成鸭子对象。
   */
  createSettingShim() {
    const open = () => this.openSettingsPanel();
    const SettingCls = SY.Setting;
    if (typeof SettingCls === "function") {
      try {
        const s = new SettingCls({});
        s.open = open;
        return s;
      } catch (e) {}
    }
    return { open };
  }

  openSettingsPanel() {
    const cfg = this.settings;
    const ui = showDialog({
      title: this.t("settingsTitle", "智能标题 · 设置"),
      width: "620px",
      height: "620px",
      content: `<div class="hm-root">
        <div class="hm-cfg hm-cfg--scroll">${cfgInnerHtml()}</div>
        <div class="hm-foot" style="margin-top:auto">
          <div class="hm-progress">改动即时保存</div>
          <div class="hm-foot__btns">
            <button class="b3-button b3-button--text" data-act="convert">打开转换面板</button>
            <button class="b3-button b3-button--outline" data-act="levels">调整标题层级</button>
            <button class="b3-button b3-button--cancel" data-act="close">关闭</button>
          </div>
        </div>
      </div>`,
    });
    const root = ui.el;
    if (!root) return;

    const sync = () => {
      root.querySelectorAll("[data-cfg]").forEach((el) => {
        const k = el.getAttribute("data-cfg");
        if (el.type === "checkbox") el.checked = !!cfg[k];
        else el.value = cfg[k];
      });
      root.querySelectorAll("[data-rule]").forEach((el) => {
        el.checked = !!cfg.rules[el.getAttribute("data-rule")];
      });
    };
    sync();

    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t || !t.hasAttribute) return;
      const k = t.getAttribute("data-cfg");
      if (k === "customKeywords") {
        cfg.customKeywords = t.value;
        this.saveSettings();
      }
    });

    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute("data-cfg")) {
        const k = t.getAttribute("data-cfg");
        cfg[k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
        this.saveSettings();
        return;
      }
      if (t.hasAttribute("data-rule")) {
        cfg.rules[t.getAttribute("data-rule")] = t.checked;
        this.saveSettings();
      }
    });

    root.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "close") {
        ui.destroy();
      } else if (act === "convert") {
        ui.destroy();
        this.openPanel("doc");
      } else if (act === "levels") {
        ui.destroy();
        this.openLevelPanel("doc");
      }
    });
  }

  onBlockIcon({ detail }) {
    const menu = detail && detail.menu;
    if (!menu) return;
    menu.addItem({
      icon: "iconH1",
      label: this.t("menuConvert", "智能标题：转换选中块"),
      click: () => this.openPanel("blocks", detail.blockElements || []),
    });
    menu.addItem({
      icon: "iconH2",
      label: this.t("menuLevel", "智能标题：调整选中块的标题层级"),
      click: () => this.openLevelPanel("blocks", detail.blockElements || []),
    });
  }

  async saveSettings() {
    try {
      await this.saveData(SETTINGS_FILE, this.settings);
    } catch (e) {
      console.info("[heading-master] 设置保存失败", e);
    }
  }

  /* ---------------- 打开面板 ---------------- */

  async openPanel(scope, elements) {
    const ed = activeEditor();
    if (!ed) {
      this.toast("没有打开中的文档");
      return;
    }
    const wysiwyg = ed.wysiwyg;
    let docId = ed.docId || "";

    let all = [];
    let src = "";

    // 首选 kramdown：一次请求拿全篇，顺序、文字、类型都来自内核，不受渲染和索引影响
    if (docId) {
      try {
        all = await this.loadBlocksFromKramdown(docId);
        if (all.length) src = "kramdown";
      } catch (e) {
        console.info("[heading-master] kramdown 读取失败", e);
      }
    }
    // 兜底：从 DOM 读
    if (!all.length) {
      all = topBlocks(wysiwyg).map(parseBlock);
      src = "dom";
      if (!docId) docId = await this.resolveDocId(all.length ? all[0].id : "");
    }

    if (!all.length) {
      this.toast(`[v${VERSION}] 读不到文档内容（${ed.info || ""}）`, 10000);
      return;
    }

    let onlyIds = null;
    let scopeEls = null;
    if (scope === "blocks") {
      const srcEls = elements && elements.length ? elements : Array.from(wysiwyg.querySelectorAll(".protyle-wysiwyg--select"));
      const ids = new Set();
      for (const el of srcEls) {
        if (!el || !el.getAttribute) continue;
        let id = el.getAttribute("data-node-id");
        if (!id && el.querySelector) {
          const inner = el.querySelector("[data-node-id]");
          if (inner) id = inner.getAttribute("data-node-id");
        }
        if (id) ids.add(id);
      }
      if (!ids.size) {
        this.toast("请先选中要转换的块");
        return;
      }
      onlyIds = ids;
      scopeEls = srcEls;
    }

    const cfg = this.settings;
    const plans = buildPlans(all, cfg, onlyIds);
    if (!plans.length) {
      this.reportEmpty(all, onlyIds, { src, info: ed.info });
      return;
    }

    this.renderPanel({ plans, cfg, docId, scope, scopeEls, all, onlyIds, src });
  }

  /* ---------------- 调整已有标题层级 ---------------- */

  async openLevelPanel(scope, elements) {
    const ed = activeEditor();
    if (!ed) {
      this.toast("没有打开中的文档");
      return;
    }
    let docId = ed.docId || "";
    let all = [];
    if (docId) {
      try {
        all = await this.loadBlocksFromKramdown(docId);
      } catch (e) {
        console.info("[heading-master] kramdown 读取失败", e);
      }
    }
    if (!all.length) {
      all = topBlocks(ed.wysiwyg).map(parseBlock);
      if (!docId) docId = await this.resolveDocId(all.length ? all[0].id : "");
    }
    if (!all.length) {
      this.toast(`[v${VERSION}] 读不到文档内容`, 8000);
      return;
    }

    let list = headingList(all);
    if (scope === "blocks" && elements && elements.length) {
      const ids = new Set();
      for (const el of elements) {
        if (!el || !el.getAttribute) continue;
        let id = el.getAttribute("data-node-id");
        if (!id && el.querySelector) {
          const inner = el.querySelector("[data-node-id]");
          if (inner) id = inner.getAttribute("data-node-id");
        }
        if (id) ids.add(id);
      }
      if (ids.size) list = list.filter((h) => ids.has(h.id));
    }
    if (!list.length) {
      this.toast("这篇文档里没有可调整的标题块");
      return;
    }
    this.renderLevelPanel(list, docId);
  }

  renderLevelPanel(list, docId) {
    const ui = showDialog({
      title: this.t("levelTitle", "调整标题层级"),
      width: "760px",
      height: "640px",
      content: levelDialogHtml(list),
    });
    const root = ui.el;
    if (!root) {
      this.toast("界面初始化失败");
      return;
    }

    const state = list.map((h) => ({ id: h.id, text: h.text, raw: h.raw, level: h.level, to: h.level }));

    const updateStat = () => {
      const chg = state.filter((h) => h.to !== h.level).length;
      const st = root.querySelector(".hm-lstat");
      if (st) st.innerHTML = `共 <b>${state.length}</b> 个标题，将修改 <b>${chg}</b> 个`;
      const btn = root.querySelector('[data-act="apply"]');
      if (btn) {
        btn.textContent = chg ? `应用（${chg}）` : "应用";
        btn.disabled = !chg;
      }
    };

    const repaint = () => {
      const listEl = root.querySelector(".hm-list");
      if (!listEl) return;
      const sc = listEl.scrollTop;
      listEl.innerHTML = state.map((h, i) => levelRowHtml(h, i)).join("");
      listEl.scrollTop = sc;
      updateStat();
    };
    updateStat();

    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t.classList || !t.classList.contains("hm-hsel")) return;
      const i = Number(t.getAttribute("data-idx"));
      if (!state[i]) return;
      state[i].to = clamp(Number(t.value) || 1, 1, 6);
      const row = t.closest(".hm-hrow");
      if (row) row.classList.toggle("hm-hrow--chg", state[i].to !== state[i].level);
      updateStat();
    });

    root.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");

      if (act === "cancel") {
        ui.destroy();
        return;
      }
      if (act === "up" || act === "down") {
        const d = act === "up" ? 1 : -1;
        state.forEach((h) => {
          h.to = clamp(h.to + d, 1, 6);
        });
        repaint();
        return;
      }
      if (act === "rule") {
        const lv = relevelHeadings(state, this.settings);
        state.forEach((h, i) => {
          h.to = clamp(lv[i], 1, 6);
        });
        repaint();
        return;
      }
      if (act === "reset") {
        state.forEach((h) => {
          h.to = h.level;
        });
        repaint();
        return;
      }
      if (act === "apply") {
        await this.runLevelApply({ ui, root, state, docId });
      }
    });
  }

  async runLevelApply({ ui, root, state, docId }) {
    const items = state.filter((h) => h.to !== h.level);
    if (!items.length) return;

    const applyBtn = root.querySelector('[data-act="apply"]');
    const cancelBtn = root.querySelector('[data-act="cancel"]');
    const progress = root.querySelector(".hm-progress");
    if (applyBtn) applyBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    let backup = "";
    try {
      if (this.settings.snapshot && docId) {
        progress.textContent = "正在保存快照…";
        backup = ((await api(API.kramdown, { id: docId })) || {}).kramdown || "";
      }
    } catch (e) {
      progress.textContent = "快照失败，已中止：" + ((e && e.message) || e);
      if (applyBtn) applyBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }

    let errors = [];
    try {
      errors = await applyLevels(items, (done, total) => {
        progress.textContent = `正在写入 ${done}/${total}`;
      });
    } catch (e) {
      errors = [{ id: "-", msg: String((e && e.message) || e) }];
    }

    if (backup && docId) {
      const tooBig = backup.length > 1.5 * 1024 * 1024;
      this.settings.lastBackup = {
        docId,
        time: Date.now(),
        count: items.length,
        tooBig,
        md: tooBig ? "" : backup,
      };
      await this.saveSettings();
    }

    if (errors.length) {
      progress.textContent = `完成 ${items.length - errors.length}/${items.length}，失败 ${errors.length}：` + truncate(errors[0].msg, 60);
      if (applyBtn) applyBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }

    progress.textContent = `已调整 ${items.length} 个标题`;
    ui.destroy();
    this.toast(`已调整 ${items.length} 个标题的层级。可用「智能标题：撤销上次转换」回退`, 6000);
  }

  renderPanel({ plans, cfg, docId, scope, scopeEls, all, onlyIds, src }) {
    const ui = showDialog({
      title: this.t("dialogTitle", "智能标题转换"),
      width: "920px",
      height: "660px",
      content: dialogHtml(plans),
    });
    const root = ui.el;
    if (!root) {
      this.toast("界面初始化失败");
      return;
    }

    let state = plans.map((p) => ({ plan: p, checked: p.conf !== "low" }));

    // 同步配置控件
    const syncCfg = () => {
      root.querySelectorAll("[data-cfg]").forEach((el) => {
        const k = el.getAttribute("data-cfg");
        if (el.type === "checkbox") el.checked = !!cfg[k];
        else el.value = cfg[k];
      });
      root.querySelectorAll("[data-rule]").forEach((el) => {
        el.checked = !!cfg.rules[el.getAttribute("data-rule")];
      });
    };
    syncCfg();

    const refreshRows = () => {
      state.forEach((s, i) => {
        const row = root.querySelector(`.hm-item[data-idx="${i}"]`);
        if (!row) return;
        row.classList.toggle("hm-item--off", !s.checked);
        const cb = row.querySelector(".hm-check");
        if (cb) cb.checked = s.checked;
      });
    };

    let planList = plans;
    let recTimer = null;

    const recount = () => {
      const on = state.filter((s) => s.checked).length;
      const btn = root.querySelector('[data-act="apply"]');
      if (btn) {
        btn.textContent = on ? `应用（${on}）` : "应用";
        btn.disabled = !on;
      }
    };
    recount();

    /* ---------- 未识别清单：漏了什么，直接摆出来 ---------- */
    const fillMiss = (bs, ps) => {
      const box = root.querySelector(".hm-miss");
      if (!box) return;
      const missed = (bs || []).filter((b) => {
        const t = String(b.text || "").trim();
        if (!t) return false;
        if (normType(b.type) !== "NodeParagraph") return false;
        if (/^!\[/.test(t)) return false; // 图片
        return !ps.some((p) => p.blockId === b.id);
      });
      if (!missed.length) {
        box.innerHTML = "";
        box.classList.add("hm-hidden");
        return;
      }
      box.classList.remove("hm-hidden");
      box.innerHTML = `<details>
        <summary>另有 ${missed.length} 条段落未被识别（点击展开）</summary>
        <div class="hm-miss__list">${missed
          .slice(0, 40)
          .map((b) => `<div class="hm-miss__row">${escHtml(truncate(String(b.text).trim(), 90))}</div>`)
          .join("")}${missed.length > 40 ? `<div class="hm-miss__row">…共 ${missed.length} 条</div>` : ""}</div>
      </details>`;
    };
    fillMiss(all, planList);

    /* ---------- 改配置后即时重算（自定义关键词必须能边填边看） ---------- */
    const recompute = () => {
      planList = buildPlans(all || [], cfg, onlyIds);
      state = planList.map((p) => ({ plan: p, checked: p.conf !== "low" }));
      const listEl = root.querySelector(".hm-list");
      if (listEl) listEl.innerHTML = listHtml(planList);
      const statEl = root.querySelector(".hm-stat");
      if (statEl) statEl.innerHTML = statHtml(planList);
      fillMiss(all, planList);
      recount();
    };
    const scheduleRecompute = () => {
      if (!all || !all.length) return;
      if (recTimer) clearTimeout(recTimer);
      recTimer = setTimeout(() => {
        recTimer = null;
        recompute();
      }, 320);
    };

    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t || !t.hasAttribute) return;
      if (t.getAttribute("data-cfg") === "customKeywords") {
        cfg.customKeywords = t.value;
        this.saveSettings();
        scheduleRecompute();
      }
    });

    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.classList.contains("hm-check")) {
        const i = Number(t.closest(".hm-item").getAttribute("data-idx"));
        state[i].checked = t.checked;
        refreshRows();
        recount();
        return;
      }
      if (t.classList.contains("hm-level")) {
        const i = Number(t.getAttribute("data-idx"));
        const lv = Number(t.value);
        state[i].plan.outputs.forEach((o) => {
          if (o.kind === "h") o.level = lv;
        });
        const row = t.closest(".hm-item");
        if (row) {
          row.querySelectorAll('[data-chip="h"] .hm-lvnum').forEach((span) => {
            span.textContent = "H" + lv;
          });
        }
        return;
      }
      if (t.hasAttribute("data-cfg")) {
        const k = t.getAttribute("data-cfg");
        cfg[k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
        this.saveSettings();
        if (k !== "snapshot") scheduleRecompute();
        return;
      }
      if (t.hasAttribute("data-rule")) {
        cfg.rules[t.getAttribute("data-rule")] = t.checked;
        this.saveSettings();
        scheduleRecompute();
        return;
      }
    });

    root.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "all" || act === "none" || act === "safe") {
        state.forEach((s) => {
          if (act === "all") s.checked = true;
          else if (act === "none") s.checked = false;
          else s.checked = s.plan.conf === "high";
        });
        refreshRows();
        recount();
        return;
      }
      if (act === "cfg") {
        const panel = root.querySelector(".hm-cfg");
        panel.classList.toggle("hm-hidden");
        return;
      }
      if (act === "levels") {
        ui.destroy();
        this.openLevelPanel(scope, scopeEls);
        return;
      }
      if (act === "cancel") {
        ui.destroy();
        return;
      }
      if (act === "apply") {
        await this.runApply({
          ui,
          root,
          state,
          cfg,
          docId,
          scope,
          scopeEls,
        });
      }
    });
  }

  async runApply({ ui, root, state, cfg, docId, scope, scopeEls }) {
    const chosen = state.filter((s) => s.checked).map((s) => s.plan);
    if (!chosen.length) return;

    const applyBtn = root.querySelector('[data-act="apply"]');
    const cancelBtn = root.querySelector('[data-act="cancel"]');
    const progress = root.querySelector(".hm-progress");
    if (applyBtn) applyBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    let backup = null;
    try {
      if (cfg.snapshot && docId) {
        progress.textContent = "正在保存快照…";
        const md = await api(API.kramdown, { id: docId });
        backup = (md && md.kramdown) || "";
      }
    } catch (e) {
      progress.textContent = "快照失败，已中止：" + ((e && e.message) || e);
      if (applyBtn) applyBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }

    let errors = [];
    try {
      errors = await applyPlans(chosen, (done, total) => {
        progress.textContent = `正在写入 ${done}/${total}`;
      });
    } catch (e) {
      errors = [{ id: "-", msg: String((e && e.message) || e) }];
    }

    if (backup && docId) {
      const tooBig = backup.length > 1.5 * 1024 * 1024;
      this.settings.lastBackup = {
        docId,
        time: Date.now(),
        count: chosen.length,
        tooBig,
        md: tooBig ? "" : backup,
      };
      await this.saveSettings();
    }

    const heads = chosen.reduce((n, p) => n + p.outputs.filter((o) => o.kind === "h").length, 0);
    const paras = chosen.reduce((n, p) => n + p.outputs.filter((o) => o.kind === "p").length, 0);

    if (errors.length) {
      progress.textContent = `完成 ${chosen.length - errors.length}/${chosen.length}，失败 ${errors.length}：` +
        truncate(errors[0].msg, 60);
      if (applyBtn) applyBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }

    ui.destroy();
    this.toast(`已转换 ${chosen.length} 个段落 → ${heads} 个标题${paras ? ` + ${paras} 段正文` : ""}`, 5000);
    if (backup) this.toast("如需回退：命令面板搜「智能标题：撤销上次转换」", 6000);
  }

  /* ---------------- 撤销 ---------------- */

  async undoLast() {
    const bak = this.settings.lastBackup;
    if (!bak) {
      this.toast("还没有转换记录");
      return;
    }
    if (!bak.md) {
      this.toast(bak.tooBig ? "上次文档过大，快照未保存，无法一键回退" : "没有可用的快照");
      return;
    }
    const when = new Date(bak.time).toLocaleString();
    const ok = window.confirm(
      `将把整篇文档还原到 ${when} 的状态（那次转换了 ${bak.count} 个段落）。\n\n此后对该文档的手动修改也会一并丢失，确定继续？`
    );
    if (!ok) return;
    try {
      await api(API.update, { id: bak.docId, dataType: "markdown", data: bak.md });
      this.settings.lastBackup = null;
      await this.saveSettings();
      this.toast("已还原到转换前");
    } catch (e) {
      this.toast("还原失败：" + ((e && e.message) || e));
    }
  }
}

/* ---------------------------- 9. 导出 ---------------------------- */

module.exports = HeadingMaster;

// 供 Node 单元测试使用（思源里加载时无害）
module.exports.__engine = {
  cn2num,
  detectMarker,
  detectCustom,
  parseCustomKeywords,
  kwList,
  firstMarker,
  scanMarkers,
  splitHeadBody,
  resolveLevel,
  buildPlan,
  buildPlans,
  applyPlans,
  headingList,
  relevelHeadings,
  applyLevels,
  parseKramdown,
  stripInline,
  normType,
  mdOf,
  escMd,
  api,
  API,
  DEFAULT_SETTINGS,
};
