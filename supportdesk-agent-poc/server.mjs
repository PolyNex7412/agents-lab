import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import * as mcp from "./mcp-client.mjs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

const DATA_DIR = path.join(__dirname, "data");
const FAQ_PATH = path.join(DATA_DIR, "faq.json");
const LOGS_PATH = path.join(DATA_DIR, "logs.json");

// ---- Utils ----
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
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
  // 正規化：クエリ長に対するヒット率
  return queryTokens.length ? hit / queryTokens.length : 0;
}

// ---- Agent 1: Intent ----
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

// ---- Agent 2: RAG retrieve (simple) ----
function ragRetrieve(text, topK = 3) {
  const faqs = readJson(FAQ_PATH, []);
  const q = (text || "").toLowerCase();

  const ranked = faqs
    .map((f) => {
      const title = (f.title || "").toLowerCase();
      const content = (f.content || "").toLowerCase();
      const tags = Array.isArray(f.tags) ? f.tags.map((t) => String(t).toLowerCase()) : [];

      // ① タグ部分一致（日本語に強い）
      let tagHits = 0;
      for (const t of tags) {
        if (t && q.includes(t)) tagHits += 1;
      }

      // ② タイトル/本文の部分一致（弱めの補助）
      let titleHit = title && q.includes(title) ? 1 : 0;

      // ③ 英数字向けの既存オーバーラップも残す（英語クエリに効く）
      const qTokens = tokenize(text);
      const docTokens = tokenize(`${f.title} ${tags.join(" ")} ${f.content}`);
      const overlap = overlapScore(qTokens, docTokens);

      // 合成スコア（タグを強く）
      const score = tagHits * 0.25 + titleHit * 0.2 + overlap * 0.4;

      return { ...f, score, _debug: { tagHits, titleHit, overlap } };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const best = ranked[0] || null;
  const confidence = best ? best.score : 0;

  return { ranked, confidence };
}

// ---- FAQ + ログの類似検索（マッチ順、参照元付き） ----
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
    return { source: "faq", id: f.id, title: f.title, content: f.content, score, intent: null };
  });

  const logItems = logs.map((log, idx) => {
    const docTokens = tokenize(log.question || "");
    const overlap = overlapScore(qTokens, docTokens);
    return {
      source: "log",
      id: log.ts || "log-" + idx,
      title: (log.question || "").slice(0, 80) + (log.question && log.question.length > 80 ? "…" : ""),
      content: null,
      score: overlap,
      intent: log.intent || null,
      ts: log.ts,
    };
  });

  const merged = [...faqItems, ...logItems]
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({ ...x, score: Number(x.score.toFixed(3)) }));
  return { items: merged, confidence: merged[0] ? merged[0].score : 0 };
}

// ---- Agent 3: Answer ----
async function answerAgent({ question, intent, retrieved }) {
  const best = retrieved?.ranked?.[0];

  // APIキーがあればLLMで整形（無くても動く）
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && best) {
    try {
      const client = new OpenAI({ apiKey });
      const resp = await client.responses.create({
        model: "gpt-5.2",
        input: [
          {
            role: "system",
            content:
              "あなたは社内サポートデスクのAIです。与えられたナレッジだけを根拠に、日本語で簡潔に手順を提示してください。根拠が弱ければ『担当へエスカレーション』を提案してください。"
          },
          {
            role: "user",
            content:
              `問い合わせ:\n${question}\n\n推定intent: ${intent}\n\nナレッジ:\n[${best.id}] ${best.title}\n${best.content}`
          }
        ]
      });
      return { answer: resp.output_text, usedLLM: true };
    } catch (e) {
      // LLM失敗時はフォールバック
    }
  }

  // フォールバック（テンプレ回答）
  if (!best) {
    return {
      answer: "該当するナレッジが見つかりませんでした。状況（エラー文・発生時刻・端末/ネットワーク環境）を添えて担当へエスカレーションしてください。",
      usedLLM: false
    };
  }

  return {
    answer:
      `【案内】(${best.id}: ${best.title})\n` +
      `${best.content}\n\n` +
      "上記で解決しない場合は、エラー文・発生時刻・端末/回線情報を添えて担当へエスカレーションしてください。",
    usedLLM: false
  };
}

// ---- Agent 4: Human escalation judge ----
function judgeAgent({ confidence, intent, answer }) {
  // しきい値はデモ用。低い/unknownは人へ
  const low = confidence < 0.25;
  const unknown = intent === "unknown";
  const saysEscalate = /エスカレーション|担当/i.test(answer);
  const needsHuman = low || unknown || saysEscalate;
  return { needsHuman, reason: low ? "low_confidence" : unknown ? "unknown_intent" : saysEscalate ? "answer_suggests_escalation" : "ok" };
}

// ---- API ----
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/api/ask", async (req, res) => {
  const question = (req.body?.question ?? "").toString().trim();
  if (!question) return res.status(400).json({ error: "question is required" });

  // MCP 経由を優先（DESIGN.md: 単一の真実の源は MCP サーバー）
  const mcpResult = await mcp.askSupport({ question, topK: 3 });
  if (mcpResult) {
    return res.json({
      answer: mcpResult.answer,
      intent: mcpResult.intent,
      confidence: mcpResult.confidence,
      needsHuman: mcpResult.needsHuman,
      citations: mcpResult.citations,
      similarItems: mcpResult.similarItems ?? [],
      trace: {
        ...mcpResult.trace,
        rag: { confidence: mcpResult.confidence, top: mcpResult.citations },
      },
    });
  }

  // フォールバック: MCP 未使用時の従来実装
  const t0 = Date.now();
  const intentR = intentAgent(question);
  const retrieved = ragRetrieve(question, 3);
  const ans = await answerAgent({ question, intent: intentR.intent, retrieved });
  const judge = judgeAgent({ confidence: retrieved.confidence, intent: intentR.intent, answer: ans.answer });

  const trace = {
    intent: intentR,
    rag: {
      confidence: Number(retrieved.confidence.toFixed(3)),
      top: retrieved.ranked.map((r) => ({ id: r.id, title: r.title, score: Number(r.score.toFixed(3)) }))
    },
    judge
  };

  const logs = readJson(LOGS_PATH, []);
  logs.push({
    ts: new Date().toISOString(),
    question,
    intent: intentR.intent,
    confidence: retrieved.confidence,
    needsHuman: judge.needsHuman,
    usedLLM: ans.usedLLM,
    latencyMs: Date.now() - t0
  });
  writeJson(LOGS_PATH, logs);

  const { items: similarItems } = searchSimilar(question, 10);
  res.json({
    answer: ans.answer,
    intent: intentR.intent,
    confidence: Number(retrieved.confidence.toFixed(3)),
    needsHuman: judge.needsHuman,
    citations: retrieved.ranked.map((r) => ({ id: r.id, title: r.title, score: Number(r.score.toFixed(3)), source: "faq" })),
    similarItems,
    trace
  });
});

app.get("/api/logs", (_req, res) => {
  res.json(readJson(LOGS_PATH, []));
});

app.get("/api/faqs", (_req, res) => {
  const faqs = readJson(FAQ_PATH, []);
  res.json({
    count: faqs.length,
    ids: faqs.map(f => f.id).slice(0, 20),
    sample: faqs.slice(0, 2)
  });
});

// 類似検索（FAQ + 過去ログ、マッチ順）
app.get("/api/similar", (req, res) => {
  const q = (req.query?.q ?? "").toString().trim();
  const topK = Math.min(30, Math.max(1, parseInt(req.query?.topK, 10) || 10));
  if (!q) return res.status(400).json({ error: "q is required" });
  const data = searchSimilar(q, topK);
  res.json(data);
});

// 追加ツール: FAQ検索のみ（ログなし）。MCP 不可時はローカル RAG でフォールバック
app.get("/api/search", async (req, res) => {
  const q = (req.query?.q ?? "").toString().trim();
  const topK = Math.min(20, Math.max(1, parseInt(req.query?.topK, 10) || 5));
  if (!q) return res.status(400).json({ error: "q is required" });
  const data = await mcp.searchFaq({ query: q, topK });
  if (data) return res.json(data);
  const { ranked, confidence } = ragRetrieve(q, topK);
  const items = ranked.map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags,
    content: r.content,
    score: Number((r.score ?? 0).toFixed(3)),
  }));
  res.json({ items, confidence: Number(confidence.toFixed(3)) });
});

// 追加ツール: 意図分類のみ
app.post("/api/classify", async (req, res) => {
  const text = (req.body?.text ?? "").toString().trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const data = await mcp.classifyIntent({ text });
  if (data) return res.json(data);
  res.status(503).json({ error: "MCP unavailable" });
});

app.get("/api/metrics", async (_req, res) => {
  const mcpMetrics = await mcp.getMetrics();
  if (mcpMetrics) return res.json(mcpMetrics);

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

  res.json({
    total,
    deflected,
    deflectionRate: Number(deflectionRate.toFixed(3)),
    avgConfidence: Number(avgConf.toFixed(3)),
    maxConfidence: Number(maxConf.toFixed(3)),
    byIntent
  });
});

function startServer(port) {
  const server = app.listen(port, () => console.log("http://localhost:" + server.address().port));
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < 3010) {
      console.warn("ポート " + port + " は使用中のため " + (port + 1) + " で再試行します。");
      startServer(port + 1);
    } else if (err.code === "EADDRINUSE") {
      console.error("ポート " + port + " は使用中です。既存の node プロセスを終了してください。");
      process.exit(1);
    } else {
      throw err;
    }
  });
}
const PORT = Number(process.env.PORT) || 3000;
startServer(PORT);
