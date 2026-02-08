/**
 * MCP クライアントブリッジ
 * Express から MCP サーバー（mcp-server.mjs）を stdio で起動し、ツールを呼び出す。
 * 設計: DESIGN.md 参照（1接続で保持、フォールバック可能）
 */
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_SERVER_PATH = path.join(__dirname, "mcp-server.mjs");

let client = null;
let transport = null;
let connecting = null;

const CONNECT_TIMEOUT_MS = 10_000;

async function getClient() {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const t = new StdioClientTransport({
      command: "node",
      args: [MCP_SERVER_PATH],
      cwd: __dirname,
    });
    const c = new Client(
      { name: "supportdesk-web-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MCP connect timeout")), CONNECT_TIMEOUT_MS)
    );
    await Promise.race([c.connect(t), timeout]);
    transport = t;
    client = c;
    connecting = null;
    return client;
  })();

  return connecting;
}

function clearClient() {
  client = null;
  transport = null;
  connecting = null;
}

/**
 * ask_support を呼び、API と同形のオブジェクトを返す。
 * @param {{ question: string, topK?: number }} params
 * @returns {Promise<{ answer: string, intent: string, confidence: number, needsHuman: boolean, citations: array, trace: object } | null>}
 *   MCP 失敗時は null（呼び出し元で従来実装にフォールバック可能）
 */
export async function askSupport(params) {
  const { question, topK = 3 } = params || {};
  if (!question || typeof question !== "string") return null;
  try {
    const c = await getClient();
    const result = await c.callTool({
      name: "ask_support",
      arguments: { question: question.trim(), topK },
    });
    if (result.isError) return null;
    const raw = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null);
    if (!raw) return null;
    return {
      answer: raw.answer,
      intent: raw.intent,
      confidence: raw.confidence,
      needsHuman: raw.needsHuman,
      citations: raw.citations ?? [],
      similarItems: raw.similarItems ?? [],
      trace: raw.trace ?? {},
    };
  } catch (e) {
    console.error("[mcp-client] ask_support error:", e?.message ?? e);
    clearClient();
    return null;
  }
}

/**
 * classify_intent を呼ぶ。問い合わせの意図だけを分類する。
 * @param {{ text: string }} params
 * @returns {Promise<{ intent: string, reason: string } | null>}
 */
export async function classifyIntent(params) {
  const text = params?.text;
  if (text == null || typeof text !== "string") return null;
  try {
    const c = await getClient();
    const result = await c.callTool({
      name: "classify_intent",
      arguments: { text: String(text).trim() },
    });
    if (result.isError) return null;
    const raw = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null);
    return raw ?? null;
  } catch (e) {
    console.error("[mcp-client] classify_intent error:", e?.message ?? e);
    clearClient();
    return null;
  }
}

/**
 * search_faq を呼ぶ。FAQ 検索のみ（ログは書かない）。
 * @param {{ query: string, topK?: number }} params
 * @returns {Promise<{ items: Array<{ id, title, tags, content, score }>, confidence: number } | null>}
 */
export async function searchFaq(params) {
  const { query, topK = 5 } = params || {};
  if (!query || typeof query !== "string") return null;
  try {
    const c = await getClient();
    const result = await c.callTool({
      name: "search_faq",
      arguments: { query: query.trim(), topK },
    });
    if (result.isError) return null;
    const raw = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null);
    return raw ?? null;
  } catch (e) {
    console.error("[mcp-client] search_faq error:", e?.message ?? e);
    clearClient();
    return null;
  }
}

/**
 * get_metrics を呼び、API と同形のオブジェクトを返す。
 * @returns {Promise<{ total: number, deflected: number, deflectionRate: number, avgConfidence: number, maxConfidence: number, byIntent: object } | null>}
 */
export async function getMetrics() {
  try {
    const c = await getClient();
    const result = await c.callTool({ name: "get_metrics", arguments: {} });
    if (result.isError) return null;
    const raw = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null);
    return raw ?? null;
  } catch (e) {
    console.error("[mcp-client] get_metrics error:", e?.message ?? e);
    clearClient();
    return null;
  }
}

/**
 * MCP が利用可能かどうか（接続試行で確認）。
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
  try {
    await getClient();
    return true;
  } catch {
    return false;
  }
}
