const M = require("../index.js");
const E = M.__engine;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got  " + g + "\n       want " + w); }
}
function truthy(name, v) {
  if (v) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + " -> " + JSON.stringify(v)); }
}

const cfg = JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS));

console.log("\n[1] 中文数字解析");
eq("一", E.cn2num("一"), 1);
eq("十", E.cn2num("十"), 10);
eq("十一", E.cn2num("十一"), 11);
eq("二十", E.cn2num("二十"), 20);
eq("二十三", E.cn2num("二十三"), 23);
eq("一百", E.cn2num("一百"), 100);
eq("3", E.cn2num("3"), 3);

console.log("\n[2] 序号识别");
const dm = (s) => { const m = E.detectMarker(s); return m ? [m.key, m.level, m.len] : null; };
eq("第一章 绪论", dm("第一章 绪论"), ["chapter", 1, 4]);
eq("第1部分 xx", dm("第1部分 总则"), ["chapter", 1, 5]);
eq("第二节 常用治法", dm("第二节 常用治法"), ["section", 2, 4]);
eq("一、总则", dm("一、总则"), ["cnNum", 2, 2]);
eq("（一）相须", dm("（一）相须"), ["cnParen", 3, 3]);
eq("(一)相须", dm("(一)相须"), ["cnParen", 3, 3]);
eq("一）相须", dm("一）相须"), ["cnParen", 3, 2]);
eq("1.风寒感冒", dm("1.风寒感冒"), ["arNum", 4, 2]);
eq("1、相须", dm("1、相须"), ["arNum", 4, 2]);
eq("全角数字 １．", dm("１．风寒感冒"), ["arNum", 4, 2]);
eq("全角数字 １、", dm("１、相须"), ["arNum", 4, 2]);
eq("全角括号数字 （１）", dm("（１）风寒表证"), ["arParen", 5, 3]);
eq("（1）风寒表证", dm("（1）风寒表证"), ["arParen", 5, 3]);
eq("① 第一点", dm("① 第一点"), ["circle", 6, 2]);
eq("1.1 概述", dm("1.1 概述"), ["multi", 3, 4]);
eq("1.1.1 细节", dm("1.1.1 细节"), ["multi", 4, 6]);
eq("小数 0.5～1.5g 不误判", dm("0.5～1.5g，分两次服"), null);
eq("3.14 会被当成 1.1 式序号（预览里取消即可）", dm("3.14 是圆周率"), ["multi", 3, 5]);
eq("2023.10 不误判", dm("2023.10 发布"), null);
eq("第一，其次 不误判", dm("第一，我们要注意"), null);
eq("第十条 不误判", dm("第十条 本法自公布之日起施行"), null);

console.log("\n[3] 标题/正文拆分");
const sh = (s) => { const r = E.splitHeadBody(s, cfg); return [r.title, r.body]; };
eq("全角空格", sh("总则　本方为治阳明腑实证之主方。"), ["总则", "本方为治阳明腑实证之主方。"]);
eq("冒号", sh("组成：大黄四两、芒硝三合"), ["组成", "大黄四两、芒硝三合"]);
eq("无分隔短句", sh("总则"), ["总则", ""]);
eq("句末标点", sh("总则。本方为治阳明腑实证之主方。"), ["总则", "本方为治阳明腑实证之主方。"]);

console.log("\n[4] 一段含多个条目");
const block = {
  id: "b1", type: "NodeParagraph", level: 0, marks: false,
  text: "一、总则　本方为治阳明腑实证之主方。二、组成　大黄四两、芒硝三合。三、用法　水煎服。",
};
const ctx0 = { prevLevel: 0, familyLevel: {} };
const p1 = E.buildPlan(block, ctx0, cfg);
eq("输出条数", p1.outputs.length, 6);
eq("标题1", [p1.outputs[0].kind, p1.outputs[0].level, p1.outputs[0].text], ["h", 2, "一、总则"]);
eq("正文1", [p1.outputs[1].kind, p1.outputs[1].text], ["p", "本方为治阳明腑实证之主方。"]);
eq("标题2", p1.outputs[2].text, "二、组成");
eq("标题3", p1.outputs[4].text, "三、用法");

console.log("\n[5] 标题混在大段文字中（序号前有正文）");
const b2 = {
  id: "b2", type: "NodeParagraph", level: 0, marks: false,
  text: "下面分别说明。一、总则　这是总则正文。二、组成　这是组成正文。",
};
const p2 = E.buildPlan(b2, { prevLevel: 0, familyLevel: {} }, cfg);
eq("首块是普通段落", [p2.outputs[0].kind, p2.outputs[0].text], ["p", "下面分别说明。"]);
eq("第二个是标题", [p2.outputs[1].kind, p2.outputs[1].text], ["h", "一、总则"]);

console.log("\n[6] 分级：文档已有 h2");
const blocks = [
  { id: "h", type: "NodeHeading", level: 2, text: "第一节", marks: false },
  { id: "p1", type: "NodeParagraph", level: 0, marks: false, text: "一、总则　甲。二、组成　乙。" },
  { id: "p2", type: "NodeParagraph", level: 0, marks: false, text: "（一）相须　丙。" },
  { id: "p3", type: "NodeParagraph", level: 0, marks: false, text: "三、用法　丁。" },
  { id: "p4", type: "NodeParagraph", level: 0, marks: false, text: "1.单行　戊。" },
];
const plans = E.buildPlans(blocks, cfg, null);
const lv = plans.map((p) => p.outputs.filter((o) => o.kind === "h").map((o) => o.level));
eq("一、二、→同一级 H3", lv[0], [3, 3]);
eq("（一）更深 H4", lv[1], [4]);
eq("回到 三、→ 回 H3", lv[2], [3]);
eq("1. 更深 H4", lv[3], [4]);

console.log("\n[7] 绝对模式");
const cfgAbs = Object.assign({}, cfg, { levelMode: "absolute" });
const plansAbs = E.buildPlans(blocks, cfgAbs, null);
const lvAbs = plansAbs.map((p) => p.outputs.filter((o) => o.kind === "h").map((o) => o.level));
eq("一、→H2", lvAbs[0], [2, 2]);
eq("（一）→H3", lvAbs[1], [3]);
eq("1.→H4", lvAbs[3], [4]);

console.log("\n[8] 序号断裂不拆");
const b3 = { id: "b3", type: "NodeParagraph", level: 0, marks: false, text: "一、甲　乙。五、丙　丁。" };
const p3 = E.buildPlan(b3, { prevLevel: 0, familyLevel: {} }, cfg);
eq("只认第一条（断裂不拆）", p3.outputs.length, 2);
truthy("标题含 五、（未被拆开）", p3.outputs[0].text.indexOf("五、") >= 0 || p3.outputs[1].text.indexOf("五、") >= 0);

console.log("\n[9] 不拆分模式");
const cfgNoSplit = Object.assign({}, cfg, { splitParagraph: false });
const p4 = E.buildPlan({ id: "b4", type: "NodeParagraph", level: 0, marks: false, text: "一、总则" }, { prevLevel: 0, familyLevel: {} }, cfgNoSplit);
eq("整段成标题", p4.outputs, [{ kind: "h", text: "一、总则", level: 2 }]);
const p5 = E.buildPlan({ id: "b5", type: "NodeParagraph", level: 0, marks: false, text: "一、总则　这是一段很长的正文内容，超过三十个字就应该被跳过，因为它显然不是标题而是一整段说明文字。" }, { prevLevel: 0, familyLevel: {} }, cfgNoSplit);
eq("过长跳过", p5, null);

console.log("\n[10] markdown 生成");
eq("h3", E.mdOf({ kind: "h", level: 3, text: "一、总则" }), "### 一、总则");
eq("段落", E.mdOf({ kind: "p", text: "正文" }), "正文");
eq("星号转义", E.mdOf({ kind: "p", text: "2 * 3" }), "2 \\* 3");

console.log("\n[11] 非段落块跳过");
const plans2 = E.buildPlans([
  { id: "l", type: "NodeList", level: 0, marks: false, text: "一、甲" },
  { id: "c", type: "NodeCodeBlock", level: 0, marks: false, text: "一、甲" },
], cfg, null);
eq("列表/代码块不处理", plans2.length, 0);

console.log("\n[12] 真实语料：序号后直接用逗号接正文");
const real = [
  { id: "r1", type: "NodeParagraph", level: 0, marks: false, text: "38.甘草干姜汤，炙甘草12克，炮干姜6克，治伤寒脉浮，自汗" },
  { id: "r2", type: "NodeParagraph", level: 0, marks: false, text: "39.二精丸，黄精、枸杞各等份，助气固精，保镇丹田" },
  { id: "r3", type: "NodeParagraph", level: 0, marks: false, text: "33. 白术、鸡内金，白术10-15g、鸡内金6-10g" },
];
const rp = E.buildPlans(real, cfg, null);
eq("三段都识别", rp.length, 3);
eq("38. 标题+级别", [rp[0].outputs[0].level, rp[0].outputs[0].text], [2, "38.甘草干姜汤"]);
eq("38. 正文", rp[0].outputs[1].text, "炙甘草12克，炮干姜6克，治伤寒脉浮，自汗");
eq("39. 标题", rp[1].outputs[0].text, "39.二精丸");
eq("33. 保留原空格", rp[2].outputs[0].text, "33. 白术、鸡内金");
eq("扁平文档最浅 H2", rp[2].outputs[0].level, 2);

console.log("\n[13] 扁平文档里的 1. 不应变成 H4");
const flat = E.buildPlans([{ id: "f1", type: "NodeParagraph", level: 0, marks: false, text: "1.风寒感冒　恶寒发热。" }], cfg, null);
eq("1. 在空文档里是 H2", flat[0].outputs[0].level, 2);

console.log("\n[14] 列表块解析（真实 kramdown 形状）");
const listMd = [
  '1. {: id="ITEM1"}参附汤：人参15～30g，附子30-120g，回阳固脱。',
  '   {: id="ITEM1b"}',
  '2. {: id="ITEM2"}金铃子散：川楝子、元胡等量，治肝郁化火证。',
  '   {: id="ITEM2b"}',
  '{: id="LISTID"}',
].join("\n");
const parsed = E.parseKramdown(listMd + "\n\n{: id=\"DOCID\" type=\"doc\" title=\"x\"}");
eq("解析出一个列表块", parsed.filter((b) => b.type === "NodeList").length, 1);
const listBlk = parsed.find((b) => b.type === "NodeList");
eq("列表块 id", listBlk.id, "LISTID");
eq("条目数", listBlk.items.length, 2);
eq("条目文字干净（去掉内嵌 id）", listBlk.items[0].text, "参附汤：人参15～30g，附子30-120g，回阳固脱。");
eq("条目序号", listBlk.items.map((i) => i.marker), ["1.", "2."]);
eq("非嵌套、非复杂", [listBlk.nested, listBlk.complex], [false, false]);

const listPlans = E.buildPlans([listBlk], cfg, null);
eq("列表能出计划", listPlans.length, 1);
eq("首条标题", [listPlans[0].outputs[0].level, listPlans[0].outputs[0].text], [2, "1.参附汤"]);
eq("首条正文", listPlans[0].outputs[1].text, "人参15～30g，附子30-120g，回阳固脱。");
eq("第二条标题", listPlans[0].outputs[2].text, "2.金铃子散");

console.log("\n[15] 转义字符还原（23\\. 这种）");
const esc = E.parseKramdown('23\\.  枳实合竹茹，能和胃止呕。枳实6-15g和胃。\n{: id="E1"}');
eq("反斜杠已还原", esc[0].text.startsWith("23."), true);
const escPlans = E.buildPlans(esc, cfg, null);
eq("转义段落能识别", escPlans.length, 1);
eq("标题", escPlans[0].outputs[0].text, "23. 枳实合竹茹，能和胃止呕");

console.log("\n[16] 嵌套列表不碰");
const nestedMd = ['1. {: id="N1"}甲：乙。', '   1. {: id="N1a"}子项：丙。', '{: id="NL2"}'].join("\n");
const nestedBlk = E.parseKramdown(nestedMd).find((b) => b.type === "NodeList");
eq("识别为嵌套", nestedBlk.nested, true);
eq("嵌套列表不生成计划", E.buildPlans([nestedBlk], cfg, null).length, 0);

console.log("\n[17] 禁止跳级：H2 下面直接出现 1. 不应跳到 H4");
const skipBlocks = [
  { id: "h2", type: "NodeHeading", level: 2, text: "第一节", marks: false },
  { id: "s1", type: "NodeParagraph", level: 0, marks: false, text: "1.上焦篇　论温病初起。" },
  { id: "s2", type: "NodeParagraph", level: 0, marks: false, text: "2.中焦篇　论邪入中焦。" },
];
const skipPlans = E.buildPlans(skipBlocks, cfg, null);
eq("1. 在 H2 下降为 H3", skipPlans[0].outputs[0].level, 3);
eq("2. 同级仍是 H3", skipPlans[1].outputs[0].level, 3);

const noSkipOff = Object.assign({}, cfg, { noSkip: false });
eq("关掉禁止跳级后回到 H4", E.buildPlans(skipBlocks, noSkipOff, null)[0].outputs[0].level, 4);

console.log("\n[18] 【标签】识别");
const br = [
  { id: "b1", type: "NodeParagraph", level: 0, marks: false, text: "【药性】辛，温。归肺、胃经。" },
  { id: "b2", type: "NodeParagraph", level: 0, marks: false, text: "【基原】" },
  { id: "b3", type: "NodeParagraph", level: 0, marks: false, text: "本品为麻黄科植物。草麻黄【应用】1.风寒感冒　恶寒发热。" },
];
const brPlans = E.buildPlans(br, cfg, null);
eq("识别 3 段", brPlans.length, 3);
eq("【药性】整体是标题", [brPlans[0].outputs[0].text, brPlans[0].outputs[0].level], ["【药性】", 2]);
eq("正文不被句号切开", brPlans[0].outputs[1].text, "辛，温。归肺、胃经。");
eq("【基原】无正文", brPlans[1].outputs.length, 1);
eq("【基原】标题", brPlans[1].outputs[0].text, "【基原】");
eq("段中【应用】前留正文", [brPlans[2].outputs[0].kind, brPlans[2].outputs[0].text], ["p", "本品为麻黄科植物。草麻黄"]);
eq("【应用】成为标题", brPlans[2].outputs[1].text, "【应用】");
eq("其后数字条目仍是正文", brPlans[2].outputs[2].text, "1.风寒感冒　恶寒发热。");

console.log("\n[19] 【标签】在 h2 下顺延为 h3");
const br2 = E.buildPlans([
  { id: "hh", type: "NodeHeading", level: 2, text: "麻黄", marks: false },
  { id: "cc", type: "NodeParagraph", level: 0, marks: false, text: "【功效】发汗解表。" },
], cfg, null);
eq("【功效】h3", br2[0].outputs[0].level, 3);

console.log("\n[20] 自定义关键词");
const ck = JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS));
const cplan = (text, c) =>
  E.buildPlan({ id: "k", type: "NodeParagraph", level: 0, marks: false, text }, { prevLevel: 0, familyLevel: {} }, c || ck);
const outs = (p) => (p ? p.outputs.map((o) => o.kind + (o.level || "") + "|" + o.text) : null);

eq("全角空格切分", outs(cplan("组成　麻黄三两。")), ["h2|组成", "p|麻黄三两。"]);
eq("半角空格切分", outs(cplan("组成 麻黄三两")), ["h2|组成", "p|麻黄三两"]);
eq("冒号切分且标题不带冒号", outs(cplan("功效：发汗解表，宣肺平喘。")), ["h2|功效", "p|发汗解表，宣肺平喘。"]);
eq("段末关键词", outs(cplan("主治")), ["h2|主治"]);
eq("严格模式不认「应用广泛」", outs(cplan("应用广泛")), null);
eq("「麻黄汤的组成」不误判", outs(cplan("麻黄汤的组成　麻黄三两")), null);
eq("「本方由药物组成」不误判", outs(cplan("本方由下列药物组成　麻黄三两")), null);

const loose = Object.assign({}, ck, { customStrict: false });
eq("宽松模式认「应用广泛」", outs(cplan("应用广泛", loose)), ["h2|应用广泛"]);

const only3 = Object.assign({}, ck, { customKeywords: "功效=3" });
eq("关键词内联级别 功效=3", outs(cplan("功效　发汗解表", only3)), ["h3|功效", "p|发汗解表"]);

const fixed2 = Object.assign({}, ck, { customLevel: 2 });
eq("默认级别 H2", outs(cplan("主治　咳嗽", fixed2)), ["h2|主治", "p|咳嗽"]);

eq("列表项也能识别", JSON.stringify(E.parseCustomKeywords("补,泻,功效,功效")), JSON.stringify([{ word: "功效", level: 0 }]));
eq("单字关键词被忽略", E.parseCustomKeywords("补").length, 0);
eq("长词优先", E.parseCustomKeywords("用法,用法用量")[0].word, "用法用量");

// 同一段里连切三块
eq(
  "段中连续切分",
  outs(cplan("麻黄汤。组成　麻黄三两　功效　发汗解表")),
  ["p|麻黄汤。", "h2|组成", "p|麻黄三两", "h2|功效", "p|发汗解表"]
);

// 与序号混用：custom 不打断序号链
const mix = E.buildPlans(
  [
    { id: "a", type: "NodeParagraph", level: 0, marks: false, text: "一、总则　本方为治阳明腑实证之主方。" },
    { id: "b", type: "NodeParagraph", level: 0, marks: false, text: "组成　大黄四两。" },
  ],
  ck,
  null
);
eq("序号 + 关键词共存", mix.length, 2);
eq("关键词级别跟随上下文（一、为 h2 → 组成为 h3）", mix[1].outputs[0].level, 3);

// 关掉开关
const offCfg = JSON.parse(JSON.stringify(ck));
offCfg.rules.custom = false;
eq("关掉自定义规则后不识别", outs(cplan("组成　麻黄三两", offCfg)), null);

// 在 H2 下顺延为 H3
const under = E.buildPlans(
  [
    { id: "h", type: "NodeHeading", level: 2, text: "麻黄", marks: false },
    { id: "p", type: "NodeParagraph", level: 0, marks: false, text: "功效　发汗解表。" },
  ],
  ck,
  null
);
eq("H2 下自定义词为 H3", under[0].outputs[0].level, 3);

console.log("\n[21] 冒号短标题（A：B）");
const cc = JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS));
const mkp = (arr) => arr.map((t, i) => ({ id: "c" + i, type: "NodeParagraph", level: 0, marks: false, text: t }));
const COLON6 = [
  "口眼喎斜：足跗上放血。",
  "眼皮上长疮：后心五、六椎间放血。",
  "青春痘：后心五、六椎间放血。",
  "肥厚性鼻炎：膏肓附近放血。",
  "牙痛：上牙痛取小腿外侧。",
  "舌下腺发炎：脚背放血。",
];

const c1 = E.buildPlans(mkp(COLON6), cc, null);
eq("6 条全部识别", c1.length, 6);
eq("标题与正文分开", outs(c1[0]), ["h2|口眼喎斜", "p|足跗上放血。"]);
eq("via 标记为 colon", c1[0].via, "colon");
eq("层级连续同层", c1.map((p) => p.outputs[0].level).join(","), "2,2,2,2,2,2");

eq("只有 2 条不启用", E.buildPlans(mkp(["注意：本品有毒。", "结论：疗效确切。"]), cc, null).length, 0);

const mixed = E.buildPlans(
  mkp([
    "这个方子的用法是这样的：水煎服。", // 冒号前 13 字，超限
    "口眼喎斜、面部麻痹：足跗放血。", // 含顿号
    "短：有效。",
    "另一个：也有效。",
    "第三个：还有效。",
    "第四个：仍然有效。",
    "第五个：依旧有效。",
  ]),
  cc,
  null
);
eq("超长/含标点的冒号头被排除，只剩 5 条", mixed.length, 5);
eq("被排除的没混进来", mixed.map((p) => p.outputs[0].text).join(","), "短,另一个,第三个,第四个,第五个");

const numFirst = E.buildPlans(mkp(COLON6.map((s, i) => i + 1 + "." + s)), cc, null);
eq("有序号时优先走序号", numFirst[0].outputs[0].text, "1.口眼喎斜");

const under2 = E.buildPlans(
  [{ id: "hh2", type: "NodeHeading", level: 2, text: "放血疗法", marks: false }].concat(mkp(COLON6)),
  cc,
  null
);
eq("H2 下顺延为 H3", under2[0].outputs[0].level, 3);

const offColon = JSON.parse(JSON.stringify(cc));
offColon.rules.colon = false;
eq("关掉冒号规则后 0 条", E.buildPlans(mkp(COLON6), offColon, null).length, 0);

const highMin = JSON.parse(JSON.stringify(cc));
highMin.colonMin = 8;
eq("门槛调到 8 条后不启用", E.buildPlans(mkp(COLON6), highMin, null).length, 0);

console.log("\n[22] 调整已有标题层级");
const hb = [
  { id: "h1", type: "NodeHeading", level: 3, text: "第一章 总论", raw: "第一章 总论", marks: false },
  { id: "h2", type: "NodeHeading", level: 3, text: "一、总则", raw: "一、总则", marks: false },
  { id: "h3", type: "NodeHeading", level: 3, text: "1.风寒感冒", raw: "1.风寒感冒", marks: false },
  { id: "h4", type: "NodeHeading", level: 3, text: "二、组成", raw: "二、组成", marks: false },
  { id: "p1", type: "NodeParagraph", level: 0, text: "正文", raw: "正文", marks: false },
];
const hl = E.headingList(hb);
eq("只提取标题块", hl.length, 4);
eq("初始 to 等于原级", hl.map((h) => h.to).join(","), "3,3,3,3");
eq("按序号重排", E.relevelHeadings(hl, cc).join(","), "1,2,3,2");

const hn = [
  { id: "a", type: "NodeHeading", level: 2, text: "没有序号的标题", raw: "没有序号的标题", marks: false },
  { id: "b", type: "NodeHeading", level: 4, text: "另一个", raw: "另一个", marks: false },
];
eq("无序号标题保持原级", E.relevelHeadings(E.headingList(hn), cc).join(","), "2,4");

const md2 = E.parseKramdown('## **加粗**的标题\n{: id="20260101000000-abcdefg"}\n\n正文\n{: id="20260101000000-hijklmn"}');
eq("标题保留原始加粗标记", md2[0].raw, "**加粗**的标题");
eq("纯文本去掉标记", md2[0].text, "加粗的标题");

console.log("\n[23] 独立短段落 → 标题");
const bs = (s, c) => E.bareShape(s, c || cc);
truthy("正向：建立人体简单化的形象", bs("建立人体简单化的形象"));
truthy("正向：容器时时刻刻在做三件事", bs("容器时时刻刻在做三件事"));
truthy("正向：如何开始学习中医", bs("如何开始学习中医"));
eq("反向：药名 2 字", bs("阿胶"), false);
eq("反向：药量 3 字", bs("各一两"), false);
eq("反向：药材行（括号+空格）", bs("猪苓（去皮）茯苓　泽泻　滑石（碎）"), false);
eq("反向：加粗行", bs("**症状**"), false);
eq("反向：转义占位符", bs("\\[附件缺失\\]"), false);
eq("反向：以「所以」开头的转折句", bs("所以我们不能这样做"), false);
eq("反向：有句号", bs("今天天气很好。"), false);
eq("反向：有逗号", bs("这是正文，不是标题"), false);
eq("反向：第X章 交给条文规则", bs("第一章节总论"), false);

const BARE_DOC = [
  "近来我参悟到，我们可以一起来想象人体从简单到复杂，哦，人就是一个容器。",
  "建立人体简单化的形象",
  "容器中装着体液，再加个心脏，心脏跳动，体液在容器中流动起来。",
  "容器时时刻刻在做三件事",
  "一是思维，产生各种各样的情绪。二是呼吸。三是饮食。五脏六腑都在其中。",
  "如何开始学习中医",
  "建议您学习从背诵《伤寒论》原文和方剂开始，先不必学中医基础理论。",
];
const bd = E.buildPlans(mkp(BARE_DOC), cc, null);
eq("三条短段落全部识别", bd.length, 3);
eq("层级都是 H2（篇内无上级标题）", bd.map((p) => p.outputs[0].level).join(","), "2,2,2");
eq("via 标记为 bare", bd[0].via, "bare");
eq("正文段落没被吞掉", bd.map((p) => p.outputs.length).join(","), "1,1,1");

const oneBare = E.buildPlans(mkp([BARE_DOC[0], "建立人体简单化的形象", BARE_DOC[2]]), cc, null);
eq("只有一条不启用（门槛 2）", oneBare.length, 0);

const runShort = E.buildPlans(mkp(["阿胶", "茯苓", "泽泻", "白术"]), cc, null);
eq("连排短行视为列表，不转换", runShort.length, 0);

const offBare = JSON.parse(JSON.stringify(cc));
offBare.rules.bare = false;
eq("关掉开关后 0 条", E.buildPlans(mkp(BARE_DOC), offBare, null).length, 0);

console.log("\n[24] 「第一，/ 第一个：」其后一句");
const oh = (s) => { const o = E.ordinalHead(s, cc); return o ? [o.num, o.unit, o.cand, o.body] : null; };
eq("第一个：学习中医的发心", oh("第一个：学习中医的发心"), ["一", "个", "学习中医的发心", ""]);
eq("第一，总则。凡……", oh("第一，总则。凡病皆由外感而起。"), ["一", "", "总则", "凡病皆由外感而起。"]);
eq("第一，我们要注意（人称开头）→ 不认", oh("第一，我们要注意"), null);
eq("第十条 本法…（空格连接）→ 不认", oh("第十条 本法自公布之日起施行。"), null);
eq("第一，这句很长而且有逗号，不是标题。→ 不认", oh("第一，这既是问题又是答案，所以不必深究。"), null);

const ORD_DOC = [
  "学习好中医的关键？ 我认为有两个",
  "第一个：学习中医的发心",
  "也可以叫做发愿、立志，这是学好的第一关键。张锡纯讲过：人先有大愿力。",
  "第二个：一心一意学临床实用的中医",
  "中医就是解决当下患者的实际问题，给出一个最佳的治疗办法。",
];
const od = E.buildPlans(mkp(ORD_DOC), cc, null);
eq("两条都识别", od.length, 2);
eq("标题保留序号并统一为顿号", od.map((p) => p.outputs[0].text).join(","), "第一个、学习中医的发心,第二个、一心一意学临床实用的中医");
eq("via 标记为 ordinal", od[0].via, "ordinal");
eq("同级 H2", od.map((p) => p.outputs[0].level).join(","), "2,2");

const oneOrd = E.buildPlans(mkp([ORD_DOC[2], ORD_DOC[3], ORD_DOC[4]]), cc, null);
eq("只有一条不启用（门槛 2）", oneOrd.length, 0);

const noSplit = JSON.parse(JSON.stringify(cc));
noSplit.splitParagraph = false;
eq("关掉拆段：带正文的「第一，总则。…」不切", E.buildPlans(mkp([ORD_DOC[2], "第一，总则。凡病皆由外感而起。"]), noSplit, null).length, 0);
eq("关掉拆段：整段就是标题的仍可转", E.buildPlans(mkp(ORD_DOC), noSplit, null).length, 2);

console.log("\n[25] 真实文档回归（如何学好中医）");
const REAL_DOC = [
  "如何学好中医？什么是中医？中医是古人在生活中观察、思考、证实出来的一套治疗疾病的思维和方法，与中国的文化传统密不可分。",
  "中就是不偏不倚，不靠左也不靠右，走中间的道。走中间道路的医生就是中医。我心目中的中医是主学中医。",
  "学习好中医的关键？ 我认为有两个",
  "第一个：学习中医的发心",
  "也可以叫做发愿，立志等等，是学习好中医的第一关键。张锡纯讲过：人先有大愿力，而后有大建树。",
  "坚定的发一个善愿，这个善愿就会慢慢成真，一切都是这样的自然，我越来越感觉到愿力的神奇。",
  "第二个：一心一意学临床实用的中医",
  "中医就是解决一个问题：如何面对当下患者的实际情况，给出一个最佳的治疗办法？如果是开药的话，每一味药是如何来的？",
  "人的精力是有限的，传统医学的知识广博精深，只能选择一种或者几种学起来最容易在临床上见到实际疗效的医学流派。",
  "我的目标是学习临床上足够使用的中医学，这个愿望最终使我选择了久经考验的仲景医学。",
  "建立人体简单化的形象",
  "近来我参悟到，我们可以一起来想象人体从简单到复杂：哦，人就是一个容器，容器中是体液，再加个心脏。",
  "容器时时刻刻在做三件事",
  "一是思维，产生各种各样的情绪。二是呼吸。三是饮食。五脏六腑是这个容器内的工厂，确保呼吸饮食的正常。",
  "了解人体，从整体到微观，有大概念，学习就成为有机整体了，看很多医书就可以贯穿了。",
  "如何开始学习中医",
  "建议您学习从背诵《伤寒论》原文和方剂开始，先不必学中医基础理论和中医诊断学。",
  "通过背诵《伤寒论》一是古文水平会提高，这是我诵读《伤寒论》的体会；二是你就能逐步理解仲景条文。",
];
const rd = E.buildPlans(mkp(REAL_DOC), cc, null);
eq("识别 5 条", rd.length, 5);
eq("标题文本", rd.map((p) => p.outputs[0].text).join(" | "),
  "第一个、学习中医的发心 | 第二个、一心一意学临床实用的中医 | 建立人体简单化的形象 | 容器时时刻刻在做三件事 | 如何开始学习中医");
eq("全部 H2", rd.map((p) => p.outputs[0].level).join(","), "2,2,2,2,2");
eq("导语段没被误判", rd.some((p) => p.src.indexOf("我认为有两个") >= 0), false);


console.log("\n[26] 层级面板：改级别后视觉同步");
{
  const r1 = E.levelRowHtml({ id: "a", text: "一、总则", level: 3, to: 3 }, 0);
  truthy("未改动 data-lv=3", r1.indexOf('data-lv="3"') >= 0);
  truthy("未改动徽标 H3", r1.indexOf(">H3</span>") >= 0);
  truthy("未改动无 chg 类", r1.indexOf("hm-hrow--chg") < 0);

  const r2 = E.levelRowHtml({ id: "a", text: "一、总则", level: 3, to: 5 }, 0);
  truthy("改到 H5 后 data-lv=5（配色跟随）", r2.indexOf('data-lv="5"') >= 0);
  truthy("徽标写清 H3→H5", r2.indexOf("H3→H5") >= 0);
  truthy("带 hm-hrow--chg", r2.indexOf("hm-hrow--chg") >= 0);
  // 缩进也按目标级别：(5-1)*14+6 = 62
  truthy("缩进按目标级别", r2.indexOf("padding-left:62px") >= 0);
  eq("改回原级则无 chg", E.levelRowHtml({ id: "a", text: "x", level: 5, to: 5 }, 0).indexOf("hm-hrow--chg") < 0, true);
}

console.log("\n[27] 未识别面板：有标题时给出调层级入口");
{
  const withHeads = E.noPlanHtml({
    total: 12,
    paraCount: 10,
    heads: [{ id: "h1", level: 2 }, { id: "h2", level: 2 }],
    samples: ["这是一段普通正文。"],
    src: "kramdown",
  });
  truthy("列出标题数量", withHeads.indexOf("已有 <b>2</b> 个标题") >= 0);
  truthy("有「调整已有标题层级」按钮", withHeads.indexOf('data-act="levels"') >= 0);
  truthy("按钮文案带数量", withHeads.indexOf("调整已有标题层级（2）") >= 0);
  truthy("有「改完规则重新识别」", withHeads.indexOf('data-act="rescan"') >= 0);
  truthy("显示段落样例", withHeads.indexOf("这是一段普通正文。") >= 0);
  truthy("展示读取路径", withHeads.indexOf("kramdown") >= 0);

  const noHeads = E.noPlanHtml({ total: 3, paraCount: 3, heads: [], samples: [], src: "dom" });
  truthy("无标题时不显示 levels 按钮", noHeads.indexOf('data-act="levels"') < 0);
  truthy("无标题时仍可改规则", noHeads.indexOf('data-act="cfg"') >= 0);
}

console.log("\n[28] 改级别时色块真的换色（转换预览）");
{
  const mkChip = (lv) => {
    const attrs = {};
    const num = { textContent: "H" + lv };
    return {
      attrs,
      num,
      setAttribute: (k, v) => (attrs[k] = v),
      querySelector: (sel) => (sel === ".hm-lvnum" ? num : null),
    };
  };
  const chip = mkChip(3);
  const body = { setAttribute() {}, querySelector: () => null };
  const row = { querySelectorAll: () => [chip, body] };
  E.paintChips(row, 5);
  eq("色块 data-lv 跟随到 5", chip.attrs["data-lv"], "5");
  eq("色块文字跟随到 H5", chip.num.textContent, "H5");
  E.paintChips(row, 1);
  eq("再改回 H1", [chip.attrs["data-lv"], chip.num.textContent], ["1", "H1"]);

  // renderRow 初始就带 data-lv，保证首屏配色正确
  const plan = { blockId: "b1", src: "一、总则　正文", marks: false, conf: "high", via: "cnNum", outputs: [{ kind: "h", level: 2, text: "一、总则" }, { kind: "p", text: "正文" }] };
  const html = E.renderRow(plan, 0, true);
  truthy("首屏色块带 data-lv=2", html.indexOf('data-chip="h" data-lv="2"') >= 0);
}

console.log("\n[29] 改级别时整行换色/缩进/徽标（层级面板）");
{
  const mkRow = () => {
    const cls = new Set();
    const attrs = {};
    const style = {};
    const badge = { textContent: "", title: "" };
    return {
      cls,
      attrs,
      style,
      badge,
      classList: {
        toggle: (n, on) => (on ? cls.add(n) : cls.delete(n)),
        contains: (n) => cls.has(n),
      },
      setAttribute: (k, v) => (attrs[k] = v),
      querySelector: (sel) => (sel === ".hm-hcur" ? badge : null),
    };
  };

  const row = mkRow();
  E.paintLevelRow(row, { level: 3, to: 5 });
  eq("行 data-lv=5", row.attrs["data-lv"], "5");
  eq("缩进 62px", row.style.paddingLeft, "62px");
  eq("徽标 H3→H5", row.badge.textContent, "H3→H5");
  truthy("带已改动标记", row.cls.has("hm-hrow--chg"));

  E.paintLevelRow(row, { level: 3, to: 3 });
  eq("改回原级 data-lv=3", row.attrs["data-lv"], "3");
  eq("改回原级缩进 34px", row.style.paddingLeft, "34px");
  eq("徽标回到 H3", row.badge.textContent, "H3");
  eq("已改动标记移除", row.cls.has("hm-hrow--chg"), false);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
