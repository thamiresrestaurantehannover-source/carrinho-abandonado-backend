/**
 * ============================================================
 *  RECUPERAÇÃO DE CARRINHO ABANDONADO — Backend Node.js
 *  Stack: Express + PostgreSQL + Z-API (WhatsApp)
 * ============================================================
 */

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors());

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,

  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE || "SUA_INSTANCIA",
  ZAPI_TOKEN:    process.env.ZAPI_TOKEN    || "SEU_TOKEN",
  ZAPI_URL: (instance) =>
    `https://api.z-api.io/instances/${instance}/token/${process.env.ZAPI_TOKEN}/send-text`,

  SEQUENCE: [
    { hoursAfter: 1,  templateId: 1, label: "Lembrete 1h"     },
    { hoursAfter: 24, templateId: 2, label: "Cupom 10% — 24h" },
    { hoursAfter: 48, templateId: 3, label: "Última chance"    },
  ],

  STORE_URL: process.env.STORE_URL || "https://sualoja.com.br",
};

// ─── BANCO DE DADOS (PostgreSQL) ──────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway.internal")
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carts (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      email        TEXT,
      total        NUMERIC NOT NULL,
      items        TEXT NOT NULL,
      cart_url     TEXT,
      status       TEXT DEFAULT 'pendente',
      abandoned_at BIGINT NOT NULL,
      created_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      cart_id     TEXT NOT NULL,
      template_id INTEGER NOT NULL,
      sent_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      success     INTEGER DEFAULT 1,
      error       TEXT
    );
  `);
  console.log("✅ Banco de dados PostgreSQL pronto.");
}

// ─── TEMPLATES DE MENSAGEM ────────────────────────────────────
function buildMessage(templateId, cart) {
  const firstName = cart.name.split(" ")[0];
  const items = typeof cart.items === "string" ? JSON.parse(cart.items) : cart.items;
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
  let number = String(phone).replace(/\D/g, "");
  if (number.length === 10 || number.length === 11) number = "55" + number;
  if (!number.startsWith("55")) number = "55" + number;

  try {
    const response = await axios.post(
      CONFIG.ZAPI_URL(CONFIG.ZAPI_INSTANCE),
      { phone: number, message },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "",
        },
        timeout: 10000,
      }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

// ─── CRON: verifica carrinhos a cada 5 minutos ────────────────
cron.schedule("*/5 * * * *", async () => {
  const now = Math.floor(Date.now() / 1000);

  const { rows: pendingCarts } = await pool.query(
    "SELECT * FROM carts WHERE status = 'pendente' OR status = 'enviado'"
  );

  for (const cart of pendingCarts) {
    const hoursElapsed = (now - parseInt(cart.abandoned_at)) / 3600;

    for (const step of CONFIG.SEQUENCE) {
      if (hoursElapsed < step.hoursAfter) continue;

      const { rows: already } = await pool.query(
        "SELECT id FROM messages WHERE cart_id = $1 AND template_id = $2",
        [cart.id, step.templateId]
      );
      if (already.length > 0) continue;

      const message = buildMessage(step.templateId, cart);
      console.log(`[CRON] Disparando ${step.label} → ${cart.phone}`);

      const result = await sendWhatsApp(cart.phone, message);

      await pool.query(
        "INSERT INTO messages (cart_id, template_id, success, error) VALUES ($1, $2, $3, $4)",
        [cart.id, step.templateId, result.success ? 1 : 0, result.error ? JSON.stringify(result.error).slice(0, 500) : null]
      );

      if (result.success) {
        await pool.query("UPDATE carts SET status = 'enviado' WHERE id = $1", [cart.id]);
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

// ── POST /webhook/carrinho ─────────────────────────────────────
app.post("/webhook/carrinho", async (req, res) => {
  try {
    const body = req.body;

    const statusPago = ["processing", "completed", "on-hold", "refunded"];
    if (body.status && statusPago.includes(body.status)) {
      console.log(`[WEBHOOK] Ignorado — pedido pago (status: ${body.status})`);
      return res.json({ ok: true, ignored: true, reason: "pedido pago" });
    }

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

    await pool.query(`
      INSERT INTO carts (id, name, phone, email, total, items, cart_url, abandoned_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        total = EXCLUDED.total,
        items = EXCLUDED.items,
        abandoned_at = EXCLUDED.abandoned_at
    `, [cart.id, cart.name, cart.phone, cart.email, cart.total, cart.items, cart.cart_url, cart.abandoned_at, cart.status]);

    console.log(`[WEBHOOK] Novo carrinho: ${cart.name} — R$ ${cart.total}`);
    res.json({ ok: true, cart_id: cart.id });
  } catch (err) {
    console.error("[WEBHOOK] Erro:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/carts ─────────────────────────────────────────────
app.get("/api/carts", async (req, res) => {
  const { status } = req.query;
  let query = "SELECT * FROM carts";
  const params = [];

  if (status && status !== "todos") {
    query += " WHERE status = $1";
    params.push(status);
  }

  query += " ORDER BY abandoned_at DESC LIMIT 200";
  const { rows: carts } = await pool.query(query, params);

  const result = await Promise.all(carts.map(async (c) => {
    const { rows } = await pool.query(
      "SELECT COUNT(*) as cnt FROM messages WHERE cart_id = $1 AND success = 1",
      [c.id]
    );
    return { ...c, items: typeof c.items === "string" ? JSON.parse(c.items) : c.items, messagesSent: parseInt(rows[0].cnt) };
  }));

  res.json(result);
});

// ── POST /api/carts/:id/send ───────────────────────────────────
app.post("/api/carts/:id/send", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM carts WHERE id = $1", [req.params.id]);
  const cart = rows[0];
  if (!cart) return res.status(404).json({ error: "Carrinho não encontrado" });

  const { templateId = 1 } = req.body;
  const message = buildMessage(templateId, cart);
  const result = await sendWhatsApp(cart.phone, message);

  const errMsg = result.error ? JSON.stringify(result.error).slice(0, 500) : null;

  await pool.query(
    "INSERT INTO messages (cart_id, template_id, success, error) VALUES ($1, $2, $3, $4)",
    [cart.id, templateId, result.success ? 1 : 0, errMsg]
  );

  if (result.success) {
    await pool.query("UPDATE carts SET status = 'enviado' WHERE id = $1", [cart.id]);
  }

  res.json(result);
});

// ── PATCH /api/carts/:id/status ───────────────────────────────
app.patch("/api/carts/:id/status", async (req, res) => {
  const { status } = req.body;
  const valid = ["pendente", "enviado", "recuperado", "falhou"];
  if (!valid.includes(status)) return res.status(400).json({ error: "Status inválido" });

  await pool.query("UPDATE carts SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ ok: true });
});

// ── GET /api/stats ─────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  const [total, pendente, enviado, recuperado, valorRisco, valorRecuperado] = await Promise.all([
    pool.query("SELECT COUNT(*) as n FROM carts"),
    pool.query("SELECT COUNT(*) as n FROM carts WHERE status = 'pendente'"),
    pool.query("SELECT COUNT(*) as n FROM carts WHERE status = 'enviado'"),
    pool.query("SELECT COUNT(*) as n FROM carts WHERE status = 'recuperado'"),
    pool.query("SELECT COALESCE(SUM(total),0) as v FROM carts WHERE status != 'recuperado'"),
    pool.query("SELECT COALESCE(SUM(total),0) as v FROM carts WHERE status = 'recuperado'"),
  ]);

  res.json({
    total:           parseInt(total.rows[0].n),
    pendente:        parseInt(pendente.rows[0].n),
    enviado:         parseInt(enviado.rows[0].n),
    recuperado:      parseInt(recuperado.rows[0].n),
    valorRisco:      parseFloat(valorRisco.rows[0].v),
    valorRecuperado: parseFloat(valorRecuperado.rows[0].v),
  });
});

// ── Health check ───────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── START ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(CONFIG.PORT, () => {
    console.log(`\n🚀 Servidor rodando na porta ${CONFIG.PORT}`);
    console.log(`📡 Webhook: POST http://localhost:${CONFIG.PORT}/webhook/carrinho`);
    console.log(`📊 API:     GET  http://localhost:${CONFIG.PORT}/api/carts\n`);
  });
}).catch(err => {
  console.error("Erro ao inicializar banco:", err);
  process.exit(1);
});
