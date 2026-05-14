/**
 * ============================================================
 *  RECUPERAÇÃO DE CARRINHO ABANDONADO — Backend Node.js
 *  Stack: Express + SQLite + Z-API (WhatsApp)
 * ============================================================
 */

const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,

  // Z-API — pegue em https://app.z-api.io
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE || "SUA_INSTANCIA",
  ZAPI_TOKEN:    process.env.ZAPI_TOKEN    || "SEU_TOKEN",
  ZAPI_URL: (instance) =>
    `https://api.z-api.io/instances/${instance}/token/${process.env.ZAPI_TOKEN}/send-text`,

  // Sequência de mensagens (em horas após abandono)
  SEQUENCE: [
    { hoursAfter: 1,  templateId: 1, label: "Lembrete 1h"     },
    { hoursAfter: 24, templateId: 2, label: "Cupom 10% — 24h" },
    { hoursAfter: 48, templateId: 3, label: "Última chance"    },
  ],

  // Domínio da sua loja para links de carrinho
  STORE_URL: process.env.STORE_URL || "https://sualoja.com.br",
};

// ─── BANCO DE DADOS (SQLite) ──────────────────────────────────
const db = new Database(path.join(__dirname, "carts.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS carts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    email        TEXT,
    total        REAL NOT NULL,
    items        TEXT NOT NULL,   -- JSON
    cart_url     TEXT,
    status       TEXT DEFAULT 'pendente',
    abandoned_at INTEGER NOT NULL,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id     TEXT NOT NULL,
    template_id INTEGER NOT NULL,
    sent_at     INTEGER DEFAULT (strftime('%s','now')),
    success     INTEGER DEFAULT 1,
    error       TEXT
  );
`);

// ─── TEMPLATES DE MENSAGEM ────────────────────────────────────
function buildMessage(templateId, cart) {
  const firstName = cart.name.split(" ")[0];
  const items = JSON.parse(cart.items);
  const itemList = items.map((i) => `• ${i.name}`).join("\n");
  const total = parseFloat(cart.total).toFixed(2);
  const url = cart.cart_url || `${CONFIG.STORE_URL}/carrinho`;

  const templates = {
    1: `Olá ${firstName}! 👋\n\nVocê deixou alguns itens no seu carrinho:\n\n🛒 ${itemList}\n\n💰 Total: R$ ${total}\n\nFinalize sua compra agora:\n${url}`,
    2: `Oi ${firstName}! 🎁\n\nAinda pensando? Temos um presente pra você!\n\nUse o cupom *VOLTA10* e ganhe 10% de desconto no seu carrinho de R$ ${total}.\n\n⏰ Válido por 24h!\n\n👉 ${url}`,
    3: `${firstName}, última chamada! ⚠️\n\nSeu carrinho expira hoje. Não perca seus itens reservados!\n\n🔗 ${url}\n\nQualquer dúvida, é só responder aqui. 😊`,
  };

  return templates[templateId] || templates[1];
}

// ─── DISPARO VIA Z-API ────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  // Formata número: remove não-dígitos, garante código do país
  let number = String(phone).replace(/\D/g, "");
  if (number.length === 10 || number.length === 11) number = "55" + number;
  if (!number.startsWith("55")) number = "55" + number;

  try {
    const response = await axios.post(
      CONFIG.ZAPI_URL(CONFIG.ZAPI_INSTANCE),
      { phone: number, message },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

// ─── CRON: verifica carrinhos a cada 5 minutos ────────────────
cron.schedule("*/5 * * * *", async () => {
  const now = Math.floor(Date.now() / 1000);
  const pendingCarts = db
    .prepare("SELECT * FROM carts WHERE status = 'pendente' OR status = 'enviado'")
    .all();

  for (const cart of pendingCarts) {
    const hoursElapsed = (now - cart.abandoned_at) / 3600;

    for (const step of CONFIG.SEQUENCE) {
      if (hoursElapsed < step.hoursAfter) continue;

      // Já foi enviado este template?
      const alreadySent = db
        .prepare("SELECT id FROM messages WHERE cart_id = ? AND template_id = ?")
        .get(cart.id, step.templateId);

      if (alreadySent) continue;

      const message = buildMessage(step.templateId, cart);
      console.log(`[CRON] Disparando ${step.label} → ${cart.phone}`);

      const result = await sendWhatsApp(cart.phone, message);

      db.prepare(
        "INSERT INTO messages (cart_id, template_id, success, error) VALUES (?, ?, ?, ?)"
      ).run(cart.id, step.templateId, result.success ? 1 : 0, result.error ? JSON.stringify(result.error).slice(0,500) : null);

      if (result.success) {
        db.prepare("UPDATE carts SET status = 'enviado' WHERE id = ?").run(cart.id);
        console.log(`[CRON] ✓ Enviado para ${cart.name} (${cart.phone})`);
      } else {
        console.error(`[CRON] ✗ Falhou para ${cart.phone}:`, result.error);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════════

// ── POST /webhook/carrinho — recebe do WooCommerce ─────────────
app.post("/webhook/carrinho", (req, res) => {
  try {
    const body = req.body;

    // Suporta formato do plugin "WooCommerce Abandoned Cart Lite"
    // e também formato customizado
    const cart = {
      id:           body.id || body.cart_id || `wc_${Date.now()}`,
      name:         body.billing?.first_name
                      ? `${body.billing.first_name} ${body.billing.last_name || ""}`.trim()
                      : body.name || "Cliente",
      phone:        body.billing?.phone || body.phone || "",
      email:        body.billing?.email || body.email || "",
      total:        parseFloat(body.cart_total || body.total || 0),
      items:        JSON.stringify(
                      body.line_items || body.items ||
                      [{ name: "Produto", qty: 1, price: body.total || 0 }]
                    ),
      cart_url:     body.cart_url || `${CONFIG.STORE_URL}/carrinho`,
      abandoned_at: Math.floor(Date.now() / 1000),
      status:       "pendente",
    };

    if (!cart.phone) {
      return res.status(400).json({ error: "Telefone obrigatório" });
    }

    // Upsert — evita duplicatas
    db.prepare(`
      INSERT INTO carts (id, name, phone, email, total, items, cart_url, abandoned_at, status)
      VALUES (@id, @name, @phone, @email, @total, @items, @cart_url, @abandoned_at, @status)
      ON CONFLICT(id) DO UPDATE SET
        total = excluded.total,
        items = excluded.items,
        abandoned_at = excluded.abandoned_at
    `).run(cart);

    console.log(`[WEBHOOK] Novo carrinho: ${cart.name} — R$ ${cart.total}`);
    res.json({ ok: true, cart_id: cart.id });
  } catch (err) {
    console.error("[WEBHOOK] Erro:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/carts — lista carrinhos para o painel ─────────────
app.get("/api/carts", (req, res) => {
  const { status } = req.query;
  let query = "SELECT * FROM carts";
  const params = [];

  if (status && status !== "todos") {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY abandoned_at DESC LIMIT 200";
  const carts = db.prepare(query).all(...params);

  // Adiciona contagem de mensagens enviadas
  const result = carts.map((c) => {
    const msgCount = db
      .prepare("SELECT COUNT(*) as cnt FROM messages WHERE cart_id = ? AND success = 1")
      .get(c.id);
    return { ...c, items: JSON.parse(c.items), messagesSent: msgCount.cnt };
  });

  res.json(result);
});

// ── POST /api/carts/:id/send — disparo manual ──────────────────
app.post("/api/carts/:id/send", async (req, res) => {
  const cart = db.prepare("SELECT * FROM carts WHERE id = ?").get(req.params.id);
  if (!cart) return res.status(404).json({ error: "Carrinho não encontrado" });

  const { templateId = 1 } = req.body;
  const message = buildMessage(templateId, cart);
  const result = await sendWhatsApp(cart.phone, message);

  const errMsg = result.error ? JSON.stringify(result.error).slice(0, 500) : null;

  db.prepare(
    "INSERT INTO messages (cart_id, template_id, success, error) VALUES (?, ?, ?, ?)"
  ).run(cart.id, templateId, result.success ? 1 : 0, errMsg);

  if (result.success) {
    db.prepare("UPDATE carts SET status = 'enviado' WHERE id = ?").run(cart.id);
  }

  res.json(result);
});

// ── PATCH /api/carts/:id/status — atualiza status ─────────────
app.patch("/api/carts/:id/status", (req, res) => {
  const { status } = req.body;
  const valid = ["pendente", "enviado", "recuperado", "falhou"];
  if (!valid.includes(status)) return res.status(400).json({ error: "Status inválido" });

  db.prepare("UPDATE carts SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

// ── GET /api/stats — métricas gerais ──────────────────────────
app.get("/api/stats", (req, res) => {
  const stats = {
    total:      db.prepare("SELECT COUNT(*) as n FROM carts").get().n,
    pendente:   db.prepare("SELECT COUNT(*) as n FROM carts WHERE status = 'pendente'").get().n,
    enviado:    db.prepare("SELECT COUNT(*) as n FROM carts WHERE status = 'enviado'").get().n,
    recuperado: db.prepare("SELECT COUNT(*) as n FROM carts WHERE status = 'recuperado'").get().n,
    valorRisco: db.prepare("SELECT COALESCE(SUM(total),0) as v FROM carts WHERE status != 'recuperado'").get().v,
    valorRecuperado: db.prepare("SELECT COALESCE(SUM(total),0) as v FROM carts WHERE status = 'recuperado'").get().v,
  };
  res.json(stats);
});

// ── Health check ───────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── START ────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Webhook: POST http://localhost:${CONFIG.PORT}/webhook/carrinho`);
  console.log(`📊 API:     GET  http://localhost:${CONFIG.PORT}/api/carts\n`);
});
