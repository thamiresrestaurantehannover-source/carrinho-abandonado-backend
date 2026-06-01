/**
 * ============================================================
 *  RECUPERAÇÃO DE CARRINHO ABANDONADO — Backend Node.js
 *  Stack: Express + PostgreSQL + Meta WhatsApp Cloud API
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

  // Meta WhatsApp Cloud API
  WA_PHONE_ID:  process.env.WHATSAPP_PHONE_ID,
  WA_TOKEN:     process.env.WHATSAPP_TOKEN,
  WA_API_URL:   `https://graph.facebook.com/v19.0`,

  SEQUENCE: [
    { hoursAfter: 1,  templateName: "carrinho_lembrete_1h",  label: "Lembrete 1h"     },
    { hoursAfter: 24, templateName: "carrinho_cupom_24h",    label: "Cupom 10% — 24h" },
    { hoursAfter: 48, templateName: "carrinho_ultima_chance", label: "Última chance"   },
  ],

  STORE_URL: process.env.STORE_URL || "https://restaurantehannover.com.br",
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

    CREATE TABLE IF NOT EXISTS nps (
      id         SERIAL PRIMARY KEY,
      phone      TEXT NOT NULL,
      name       TEXT NOT NULL,
      nota       INTEGER,
      feedback   TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
  `);
  console.log("✅ Banco de dados PostgreSQL pronto.");
}

// ─── FORMATAR NÚMERO ──────────────────────────────────────────
function formatPhone(phone) {
  let number = String(phone).replace(/\D/g, "");
  if (number.length === 10 || number.length === 11) number = "55" + number;
  if (!number.startsWith("55")) number = "55" + number;
  return number;
}

// ─── ENVIO VIA META CLOUD API — TEMPLATE ─────────────────────
async function sendTemplate(phone, templateName, components = []) {
  const number = formatPhone(phone);

  try {
    const response = await axios.post(
      `${CONFIG.WA_API_URL}/${CONFIG.WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: number,
        type: "template",
        template: {
          name: templateName,
          language: { code: "pt_BR" },
          components: components.length > 0 ? components : undefined,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CONFIG.WA_TOKEN}`,
        },
        timeout: 10000,
      }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

// ─── ENVIO VIA META CLOUD API — TEXTO LIVRE ──────────────────
async function sendText(phone, message) {
  const number = formatPhone(phone);

  try {
    const response = await axios.post(
      `${CONFIG.WA_API_URL}/${CONFIG.WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: number,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CONFIG.WA_TOKEN}`,
        },
        timeout: 10000,
      }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response?.data || err.message };
  }
}

// ─── MONTAR COMPONENTES DO TEMPLATE CARRINHO ─────────────────
function buildCartComponents(templateName, cart) {
  const firstName = cart.name.split(" ")[0];
  const total = parseFloat(cart.total).toFixed(2);
  const url = cart.cart_url || `${CONFIG.STORE_URL}/carrinho`;

  if (templateName === "carrinho_lembrete_1h") {
    return [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName },
          { type: "text", text: total },
        ],
      },
    ];
  }

  if (templateName === "carrinho_cupom_24h") {
    return [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName },
          { type: "text", text: total },
        ],
      },
    ];
  }

  if (templateName === "carrinho_ultima_chance") {
    return [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName },
          { type: "text", text: url },
        ],
      },
    ];
  }

  return [];
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

      const templateId = CONFIG.SEQUENCE.indexOf(step) + 1;

      const { rows: already } = await pool.query(
        "SELECT id FROM messages WHERE cart_id = $1 AND template_id = $2",
        [cart.id, templateId]
      );
      if (already.length > 0) continue;

      const components = buildCartComponents(step.templateName, cart);

      console.log(`[CRON] Disparando ${step.label} → ${cart.phone}`);
      const result = await sendTemplate(cart.phone, step.templateName, components);

      await pool.query(
        "INSERT INTO messages (cart_id, template_id, success, error) VALUES ($1, $2, $3, $4)",
        [cart.id, templateId, result.success ? 1 : 0, result.error ? JSON.stringify(result.error).slice(0, 500) : null]
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
//  WEBHOOK META — recebe respostas dos clientes (NPS)
// ═══════════════════════════════════════════════════════════════

app.get("/webhook/meta", (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "hannover_verify";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[META] Webhook verificado!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook/meta", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return res.sendStatus(404);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const phone = msg.from;
    const contacts = value?.contacts;
    const name = contacts?.[0]?.profile?.name || "Cliente";

    // Resposta de botão (NPS)
    if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
      const buttonText = msg.interactive.button_reply.title;
      console.log(`[NPS] ${name} (${phone}) respondeu: ${buttonText}`);

      let nota = null;
      if (buttonText.includes("8")) nota = 8;
      else if (buttonText.includes("9")) nota = 9;
      else if (buttonText.includes("10")) nota = 10;

      if (nota) {
        await pool.query(
          "INSERT INTO nps (phone, name, nota) VALUES ($1, $2, $3)",
          [phone, name, nota]
        );

        if (nota === 10) {
          await sendTemplate(phone, "nps_followup_promotor", [
            { type: "body", parameters: [{ type: "text", text: name.split(" ")[0] }] },
          ]);
        } else {
          await sendTemplate(phone, "nps_followup_melhoria", [
            { type: "body", parameters: [{ type: "text", text: name.split(" ")[0] }] },
          ]);
        }
      }
    }

    // Resposta de texto livre (follow-up NPS)
    if (msg.type === "text") {
      const text = msg.text?.body;
      console.log(`[MSG] ${name} (${phone}): ${text}`);

      await pool.query(
        "UPDATE nps SET feedback = $1 WHERE phone = $2 AND feedback IS NULL ORDER BY created_at DESC LIMIT 1",
        [text, phone]
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[META WEBHOOK] Erro:", err);
    res.sendStatus(500);
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════════

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

app.post("/api/nps/send", async (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !name) return res.status(400).json({ error: "phone e name obrigatórios" });

  const firstName = name.split(" ")[0];
  const result = await sendTemplate(phone, "nps_avaliacao", [
    { type: "body", parameters: [{ type: "text", text: firstName }] },
  ]);

  res.json(result);
});

app.get("/api/nps", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM nps ORDER BY created_at DESC LIMIT 200");
  res.json(rows);
});

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

app.post("/api/carts/:id/send", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM carts WHERE id = $1", [req.params.id]);
  const cart = rows[0];
  if (!cart) return res.status(404).json({ error: "Carrinho não encontrado" });

  const { templateId = 1 } = req.body;
  const step = CONFIG.SEQUENCE[templateId - 1];
  if (!step) return res.status(400).json({ error: "Template inválido" });

  const components = buildCartComponents(step.templateName, cart);
  const result = await sendTemplate(cart.phone, step.templateName, components);

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

app.patch("/api/carts/:id/status", async (req, res) => {
  const { status } = req.body;
  const valid = ["pendente", "enviado", "recuperado", "falhou"];
  if (!valid.includes(status)) return res.status(400).json({ error: "Status inválido" });

  await pool.query("UPDATE carts SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ ok: true });
});

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

app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── START ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(CONFIG.PORT, () => {
    console.log(`\n🚀 Servidor rodando na porta ${CONFIG.PORT}`);
    console.log(`📡 Webhook carrinho: POST http://localhost:${CONFIG.PORT}/webhook/carrinho`);
    console.log(`📡 Webhook Meta:     POST http://localhost:${CONFIG.PORT}/webhook/meta`);
    console.log(`📊 API:              GET  http://localhost:${CONFIG.PORT}/api/carts\n`);
  });
}).catch(err => {
  console.error("Erro ao inicializar banco:", err);
  process.exit(1);
});
