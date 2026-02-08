import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const FAQ_PATH = path.join(DATA_DIR, "faq.json");
const LOGS_PATH = path.join(DATA_DIR, "logs.json");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function overlapScore(queryTokens, docTokens) {
  const q = new Set(queryTokens);
  let hit = 0;
  for (const t of docTokens) if (q.has(t)) hit++;
  return queryTokens.length ? hit / queryTokens.length : 0;
}

function intentAgent(text) {
  const t = text.toLowerCase();
  if (/(password|パスワード|ログイン|reset|リセット)/i.test(t)) return { intent: "account_password", reason: "password/login keywords" };
  if (/(vpn|在宅|リモート|接続|つながら)/i.test(t)) return { intent: "network_vpn", reason: "vpn/connectivity keywords" };
  if (/(調達|購買|発注|po|注文書|見積|検収|請求|取引先|ベンダ|サプライヤ|承認フロー|申請)/i.test(t)) {
    return { intent: "procurement", reason: "procurement keywords" };
  }
  if (/(mail|メール|outlook|送信|受信|smtp)/i.test(t)) return { intent: "email_issue", reason: "email keywords" };
  return { intent: "unknown", reason: "no strong keywords" };
}

function ragRetrieve(text, topK = 3) {
  const faqs = readJson(FAQ_PATH, []);
  const q = (text || "").toLowerCase();

  const ranked = faqs
    .map((f) => {
      const title = (f.title || "").toLowerCase();
      const tags = Array.isArray(f.tags) ? f.tags.map((t) => String(t).toLowerCase()) : [];
      let tagHits = 0;
      for (const t of tags) if (t && q.includes(t)) tagHits += 1;
      const titleHit = title && q.includes(title) ? 1 : 0;
      const qTokens = tokenize(text);
      const docTokens = tokenize(`${f.title} ${tags.join(" ")} ${f.content}`);
      const overlap = overlapScore(qTokens, docTokens);
      const score = tagHits * 0.25 + titleHit * 0.2 + overlap * 0.4;
      return { ...f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const best = ranked[0] || null;
  return { ranked, confidence: best ? best.score : 0 };
}

/** FAQ + 過去ログをまとめて類似度で検索し、マッチ順で返す。参照元は source: "faq" | "log" */
function searchSimilar(text, topK = 10) {
  const faqs = readJson(FAQ_PATH, []);
  const logs = readJson(LOGS_PATH, []);
  const q = (text || "").toLowerCase();
  const qTokens = tokenize(text);

  const faqItems = faqs.map((f) => {
    const title = (f.title || "").toLowerCase();
    const tags = Array.isArray(f.tags) ? f.tags.map((t) => String(t).toLowerCase()) : [];
    let tagHits = 0;
    for (const t of tags) if (t && q.includes(t)) tagHits += 1;
    const titleHit = title && q.includes(title) ? 1 : 0;
    const docTokens = tokenize(`${f.title} ${tags.join(" ")} ${f.content}`);
    const overlap = overlapScore(qTokens, docTokens);
    const score = tagHits * 0.25 + titleHit * 0.2 + overlap * 0.4;
    return {
      source: "faq",
      id: f.id,
      title: f.title,
      content: f.content,
      score,
      intent: null,
    };
  });

  const logItems = logs.map((log, idx) => {
    const docTokens = tokenize(log.question || "");
    const overlap = overlapScore(qTokens, docTokens);
    const score = overlap;
    return {
      source: "log",
      id: log.ts || "log-" + idx,
      title: (log.question || "").slice(0, 80) + (log.question && log.question.length > 80 ? "…" : ""),
      content: null,
      score,
      intent: log.intent || null,
      ts: log.ts,
    };
  });

  const merged = [...faqItems, ...logItems]
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({
      ...x,
      score: Number(x.score.toFixed(3)),
    }));

  const confidence = merged[0] ? merged[0].score : 0;
  return { items: merged, confidence };
}

function answerFallback(retrieved) {
  const best = retrieved?.ranked?.[0];
  if (!best) {
    return "該当するナレッジが見つかりませんでした。状況（エラー文・発生時刻・端末/ネットワーク環境）を添えて担当へエスカレーションしてください。";
  }
  return (
    `【案内】(${best.id}: ${best.title})\n` +
    `${best.content}\n\n` +
    "上記で解決しない場合は、エラー文・発生時刻・端末/回線情報を添えて担当へエスカレーションしてください。"
  );
}

function judgeAgent({ confidence, intent, answer }) {
  const low = confidence < 0.25;
  const unknown = intent === "unknown";
  const saysEscalate = /エスカレーション|担当/i.test(answer);
  const needsHuman = low || unknown || saysEscalate;
  return { needsHuman, reason: low ? "low_confidence" : unknown ? "unknown_intent" : saysEscalate ? "answer_suggests_escalation" : "ok" };
}

const server = new McpServer({
  name: "supportdesk-agent-mcp",
  version: "1.0.0",
});

server.registerResource(
  "faq-data",
  "file:///supportdesk/faq.json",
  { mimeType: "application/json", description: "FAQ knowledge base" },
  async () => ({
    contents: [{ uri: "file:///supportdesk/faq.json", text: JSON.stringify(readJson(FAQ_PATH, []), null, 2) }],
  })
);

server.registerResource(
  "logs-data",
  "file:///supportdesk/logs.json",
  { mimeType: "application/json", description: "Question/answer logs" },
  async () => ({
    contents: [{ uri: "file:///supportdesk/logs.json", text: JSON.stringify(readJson(LOGS_PATH, []), null, 2) }],
  })
);

// --- 単機能ツール（拡張・組み合わせ用）---

server.registerTool(
  "classify_intent",
  {
    description: "Classify the intent/category of a support question (password, VPN, procurement, email, or unknown)",
    inputSchema: {
      text: z.string().min(1).describe("User message or question to classify"),
    },
  },
  async ({ text }) => {
    const result = intentAgent(text);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

server.registerTool(
  "search_similar",
  {
    description: "Search both FAQ and past inquiry logs by similarity, return a single list sorted by match score (source: faq | log).",
    inputSchema: {
      query: z.string().min(1).describe("Search query or question"),
      topK: z.number().int().min(1).max(30).optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, topK = 10 }) => {
    const { items, confidence } = searchSimilar(query, topK);
    return {
      content: [{ type: "text", text: JSON.stringify({ items, confidence }, null, 2) }],
      structuredContent: { items, confidence },
    };
  }
);

server.registerTool(
  "search_faq",
  {
    description: "Search FAQ by query and return ranked candidates (no answer text, no logging). Use for preview or composition with other tools.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      topK: z.number().int().min(1).max(20).optional().describe("Max number of results (default 5)"),
    },
  },
  async ({ query, topK = 5 }) => {
    const { ranked, confidence } = ragRetrieve(query, topK);
    const items = ranked.map((r) => ({
      id: r.id,
      title: r.title,
      tags: r.tags,
      content: r.content,
      score: Number(r.score.toFixed(3)),
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ items, confidence }, null, 2) }],
      structuredContent: { items, confidence },
    };
  }
);

server.registerTool(
  "ask_support",
  {
    description: "Classify, retrieve, and answer a support question using local FAQ data",
    inputSchema: {
      question: z.string().min(1).describe("User support question"),
      topK: z.number().int().min(1).max(10).optional().describe("Number of retrieval candidates"),
    },
  },
  async ({ question, topK = 3 }) => {
    const t0 = Date.now();
    const intentR = intentAgent(question);
    const retrieved = ragRetrieve(question, topK);
    const answer = answerFallback(retrieved);
    const judge = judgeAgent({ confidence: retrieved.confidence, intent: intentR.intent, answer });
    const { items: similarItems } = searchSimilar(question, 10);
    const result = {
      answer,
      intent: intentR.intent,
      confidence: Number(retrieved.confidence.toFixed(3)),
      needsHuman: judge.needsHuman,
      citations: retrieved.ranked.map((r) => ({ id: r.id, title: r.title, score: Number(r.score.toFixed(3)), source: "faq" })),
      similarItems,
      trace: {
        intent: intentR,
        judge,
      },
    };

    const logs = readJson(LOGS_PATH, []);
    logs.push({
      ts: new Date().toISOString(),
      question,
      intent: intentR.intent,
      confidence: retrieved.confidence,
      needsHuman: judge.needsHuman,
      usedLLM: false,
      latencyMs: Date.now() - t0,
      channel: "mcp",
    });
    writeJson(LOGS_PATH, logs);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

server.registerTool(
  "get_metrics",
  {
    description: "Return aggregate support metrics from logs.json",
    inputSchema: {},
  },
  async () => {
    const logs = readJson(LOGS_PATH, []);
    const total = logs.length;
    const deflected = logs.filter((l) => !l.needsHuman).length;
    const deflectionRate = total ? deflected / total : 0;
    const byIntent = {};
    let avgConf = 0;
    let maxConf = 0;
    for (const l of logs) {
      byIntent[l.intent] = (byIntent[l.intent] || 0) + 1;
      avgConf += l.confidence || 0;
      if ((l.confidence || 0) > maxConf) maxConf = l.confidence || 0;
    }
    avgConf = total ? avgConf / total : 0;
    const metrics = {
      total,
      deflected,
      deflectionRate: Number(deflectionRate.toFixed(3)),
      avgConfidence: Number(avgConf.toFixed(3)),
      maxConfidence: Number(maxConf.toFixed(3)),
      byIntent,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }],
      structuredContent: metrics,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("SupportDesk MCP server running on stdio");
