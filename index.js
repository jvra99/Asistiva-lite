const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const path       = require("path");
const { Server } = require("socket.io");
const { Pool }   = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const PDFDocument = require("pdfkit");
const bcrypt      = require("bcrypt");
const QRCode      = require("qrcode");
const crypto      = require("crypto");
const webpush     = require("web-push");
const formidable  = require("formidable");
const app    = express();
const server = http.createServer(app);
app.set("trust proxy", true);
// =========================
// BASE DE DATOS
// =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});
// Forzar la zona horaria de CADA conexión a UTC. Sin esto, si la sesión de
// PostgreSQL viene configurada en otra zona (p.ej. America/Santiago vía la
// config de Railway), las conversiones `created_at AT TIME ZONE
// 'America/Santiago'` se duplican y empujan las fechas al día siguiente,
// rompiendo todos los filtros "de hoy". Con la sesión en UTC, created_at
// (TIMESTAMPTZ, guardado en UTC) se convierte a Chile de forma correcta.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'UTC'").catch(() => {});
});
function safeRow(row) {
  if (!row) return row;
  const r = {};
  for (const [k, v] of Object.entries(row)) {
    r[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return r;
}
pool.connect()
  .then(async () => {
    console.log("✅ Conectado a PostgreSQL");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS informes_mensuales (
        id          SERIAL PRIMARY KEY,
        anio        INTEGER NOT NULL,
        mes         INTEGER NOT NULL,
        nombre      VARCHAR(50) NOT NULL,
        s3_key      TEXT NOT NULL,
        s3_url      TEXT,
        generado_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(anio, mes)
      )
    `).then(() => console.log("✅ informes_mensuales OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes_cuenta (
        id            SERIAL PRIMARY KEY,
        nombre        VARCHAR(100) NOT NULL,
        apellidos     VARCHAR(100) NOT NULL,
        rut           VARCHAR(20),
        email         VARCHAR(150) NOT NULL UNIQUE,
        telefono      VARCHAR(20),
        rol           VARCHAR(30) DEFAULT 'Vendedor',
        password_hash TEXT NOT NULL,
        estado        VARCHAR(20) DEFAULT 'pendiente',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `).then(() => console.log("✅ solicitudes_cuenta OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS codigos_recuperacion (
        id         SERIAL PRIMARY KEY,
        email      VARCHAR(150) NOT NULL,
        codigo     VARCHAR(10) NOT NULL,
        expira_at  TIMESTAMPTZ NOT NULL,
        usado      BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).then(() => console.log("✅ codigos_recuperacion OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qr_generados (
        id         SERIAL PRIMARY KEY,
        pasillo    VARCHAR(20) NOT NULL,
        nivel      VARCHAR(10) NOT NULL,
        url        TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).then(() => console.log("✅ qr_generados OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`
      ALTER TABLE qr_generados
        ADD COLUMN IF NOT EXISTS titulo      TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS descripcion TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS imagen_url  TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS imagen_data TEXT DEFAULT ''
    `).then(() => console.log("✅ Columnas QR extendidas OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`
      ALTER TABLE qr_generados DROP CONSTRAINT IF EXISTS qr_generados_pasillo_nivel_key
    `).then(() => console.log("✅ UNIQUE constraint removido OK")).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           SERIAL PRIMARY KEY,
        usuario_id   INTEGER NOT NULL,
        rol          VARCHAR(20) NOT NULL,
        subscription JSONB NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(usuario_id)
      )
    `).then(() => console.log("✅ push_subscriptions OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT`)
      .then(() => console.log("✅ password_hash OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE`)
      .then(() => console.log("✅ must_change_password OK")).catch(() => {});
    await pool.query(`ALTER TABLE breaks ALTER COLUMN fin DROP NOT NULL`)
      .then(() => console.log("✅ breaks.fin nullable OK")).catch(() => {});
  })
  .catch(err => console.error("❌ Error conectando a PostgreSQL:", err.message));
// =========================
// WEB PUSH (VAPID)
// =========================
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || "BG8q8Gq2jfuHOTUAIuqgNAn9sHIlatehrTeKoljt9iZ_4mVZGaflT0iZK5ijUtNcfZWJUAQyBKWv9j_v-BroPb8";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "nUVRNjT7lRbwv_AE_LeJJwVaXkEwWV3awOgPXI0-jsM";
webpush.setVapidDetails("mailto:admin@grupovhmc.cl", VAPID_PUBLIC, VAPID_PRIVATE);
// Diagnóstico: confirmar en logs de Railway si las env vars están definidas
// y si coinciden con los valores hardcodeados de respaldo (para detectar
// un posible mismatch público/privado si solo se configuró una de las dos).
const HARDCODED_PUBLIC  = "BG8q8Gq2jfuHOTUAIuqgNAn9sHIlatehrTeKoljt9iZ_4mVZGaflT0iZK5ijUtNcfZWJUAQyBKWv9j_v-BroPb8";
const HARDCODED_PRIVATE = "nUVRNjT7lRbwv_AE_LeJJwVaXkEwWV3awOgPXI0-jsM";
console.log("🔑 VAPID_PUBLIC  origen:", process.env.VAPID_PUBLIC  ? "env" : "hardcoded", "| coincide con hardcoded:", VAPID_PUBLIC  === HARDCODED_PUBLIC);
console.log("🔑 VAPID_PRIVATE origen:", process.env.VAPID_PRIVATE ? "env" : "hardcoded", "| coincide con hardcoded:", VAPID_PRIVATE === HARDCODED_PRIVATE);
async function sendPush(usuarioId, title, body, data = {}) {
  let endpointGuardado = null; // visible en el catch
  try {
    const { rows } = await pool.query(
      `SELECT subscription FROM push_subscriptions WHERE usuario_id=$1`, [usuarioId]
    );
    if (rows.length === 0) {
      console.log(`⚠️ Push: sin suscripción para usuario ${usuarioId}`);
      return;
    }
    endpointGuardado = rows[0].subscription?.endpoint || null;
    console.log(`📤 Push enviando a usuario ${usuarioId}: ${title}`);
    await webpush.sendNotification(rows[0].subscription, JSON.stringify({ title, body, data }));
    console.log(`✅ Push enviado a usuario ${usuarioId}`);
    limpiar410(usuarioId);
  } catch (err) {
    console.error(`❌ Push error usuario ${usuarioId}: status=${err.statusCode} | ${err.body || err.message}`);
    if (err.statusCode === 410 || err.statusCode === 404) {
      await registrar410(usuarioId, endpointGuardado);
    }
  }
}
async function sendPushToAdmins(title, body, data = {}) {
  let enviados = 0;
  let suscritos = 0;
  try {
    const { rows } = await pool.query(
      `SELECT ps.usuario_id, ps.subscription
       FROM push_subscriptions ps
       JOIN usuarios u ON u.id = ps.usuario_id
       WHERE u.rol IN ('Admin','Supervisor') AND u.activo = true`
    );
    suscritos = rows.length;
    console.log(`📤 sendPushToAdmins: ${rows.length} admin(s) suscrito(s) → "${title}"`);
    const payload = JSON.stringify({ title, body, data });
    for (const row of rows) {
      try {
        await webpush.sendNotification(row.subscription, payload);
        console.log(`✅ Push admin enviado a usuario ${row.usuario_id}`);
        limpiar410(row.usuario_id);
        enviados++;
      } catch (err) {
        console.error(`❌ Push admin error usuario ${row.usuario_id}: status=${err.statusCode}`);
        // Si es 410 (suscripción expirada), contar; tras varios, borrarla.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await registrar410(row.usuario_id, row.subscription?.endpoint);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error sendPushToAdmins:", err.message);
  }
  return { enviados, suscritos };
}
// Control de umbrales para notificaciones (evita spam)
const _pushState = {
  vendedores: {},  // { vendedorId: ultimaCantidadNotificada }
  adminUltimo: 0,
};
// Contador de errores 410 consecutivos por usuario. Una suscripción que da 410
// de forma repetida está realmente muerta (no es el 410 transitorio de Android)
// y debe borrarse para que deje de fallar en cada ciclo.
const _push410 = {};  // { usuarioId: cantidadDe410Consecutivos }
const MAX_410 = 2;     // borrar tras este número de 410 seguidos
async function registrar410(usuarioId, endpoint) {
  _push410[usuarioId] = (_push410[usuarioId] || 0) + 1;
  console.log(`⚠️ 410 #${_push410[usuarioId]} para usuario ${usuarioId}`);
  if (_push410[usuarioId] >= MAX_410) {
    try {
      // Borrar solo la suscripción específica (por endpoint) que está muerta.
      if (endpoint) {
        await pool.query(
          `DELETE FROM push_subscriptions WHERE usuario_id=$1 AND subscription->>'endpoint'=$2`,
          [usuarioId, endpoint]
        );
      } else {
        await pool.query(`DELETE FROM push_subscriptions WHERE usuario_id=$1`, [usuarioId]);
      }
      console.log(`🗑️ Suscripción muerta borrada para usuario ${usuarioId} (tras ${_push410[usuarioId]} errores 410). Debe re-activar notificaciones.`);
    } catch (e) { console.log(`Error borrando suscripción muerta ${usuarioId}:`, e.message); }
    delete _push410[usuarioId];
  }
}
function limpiar410(usuarioId) {
  if (_push410[usuarioId]) delete _push410[usuarioId];
}
// Verifica solicitudes por vencer y notifica a vendedores y admins. Se llama:
//  (1) cada 15s por el setInterval (respaldo, cubre reinicios del servidor)
//  (2) de inmediato vía setTimeout programado para el instante exacto en que
//      una solicitud recién creada cumple los 3 minutos (notificación inmediata)
async function chequearPorVencer() {
  try {
    // Notificar vendedores con >= 3 solicitudes por vencer
    const { rows: vends } = await pool.query(
      `SELECT
         vendedor_id,
         COUNT(*) FILTER (WHERE (NOW()-created_at) >= INTERVAL '3 minutes') AS por_vencer,
         COUNT(*) AS total_activas
       FROM solicitudes
       WHERE estado IN ('pendiente','asignada','en_curso')
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date
         AND vendedor_id IS NOT NULL
       GROUP BY vendedor_id
       HAVING COUNT(*) FILTER (WHERE (NOW()-created_at) >= INTERVAL '3 minutes') >= 3`
    );
    for (const v of vends) {
      const cant    = Number(v.por_vencer);
      const activas = Number(v.total_activas);
      const prev    = _pushState.vendedores[v.vendedor_id] || 0;
      // Solo notificar si la cantidad subió
      if (cant > prev) {
        _pushState.vendedores[v.vendedor_id] = cant;
        await sendPush(
          v.vendedor_id,
          '⚠️ Solicitudes urgentes',
          `Tienes ${cant} solicitud${cant > 1 ? 'es' : ''} por vencer. Total activas: ${activas}.`,
          { tipo: 'por_vencer', cantidad: cant }
        );
      }
    }
    // Resetear vendedores que ya no tienen por vencer
    for (const vid of Object.keys(_pushState.vendedores)) {
      if (!vends.find(v => String(v.vendedor_id) === String(vid))) {
        _pushState.vendedores[vid] = 0;
      }
    }
    // Notificar admins por umbrales (1, 5, 10, 20)
    const { rows: adminCheck } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM solicitudes
       WHERE estado IN ('pendiente','asignada')
         AND (NOW() - created_at) >= INTERVAL '3 minutes'
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
    );
    const total = Number(adminCheck[0]?.cnt || 0);
    // Notificar a los admins cada vez que el número de solicitudes por vencer
    // AUMENTA respecto a la última notificación (apareció al menos una nueva
    // solicitud vencida). Así no depende de cruzar umbrales fijos y los admins
    // se enteran de cada nueva. No se re-notifica si el número baja o se
    // mantiene, para evitar spam.
    if (total > _pushState.adminUltimo) {
      console.log(`🔴 Notificando a admins: ${total} por vencer`);
      const { enviados, suscritos } = await sendPushToAdmins(
        '🔴 Solicitudes por vencer',
        `Hay ${total} solicitud${total > 1 ? 'es' : ''} por vencer. Revisa si es necesario reasignar.`,
        { tipo: 'admin_por_vencer', cantidad: total }
      );
      // Tres casos:
      //  - Llegó a alguien (enviados>0): marcar como notificado. ✓
      //  - NO hay suscriptores (suscritos===0): marcar igual, para NO reintentar
      //    cada 15s en bucle (no hay nada que reintentar hasta que un admin se
      //    suscriba; cuando lo haga, recibe la notificación inmediata al activar).
      //  - Hay suscriptores pero todos fallaron con 410 (enviados===0 &&
      //    suscritos>0): NO marcar, para reintentar — la suscripción pudo rotar
      //    y recuperarse en el próximo ciclo.
      if (enviados > 0 || suscritos === 0) _pushState.adminUltimo = total;
    } else if (total < _pushState.adminUltimo) {
      // El número bajó (se atendieron/reasignaron): actualizar el contador de
      // referencia para que una nueva subida vuelva a notificar.
      _pushState.adminUltimo = total;
    }
  } catch (err) {
    console.error("❌ Error notificaciones por vencer:", err.message);
  }
}
// Respaldo: cada 15s (cubre reinicios y casos donde no se programó timer).
setInterval(chequearPorVencer, 15 * 1000);
// Notificación INMEDIATA: programa un chequeo para el instante exacto en que
// una solicitud cumpla 3 minutos. Se llama al crear/asignar cada solicitud.
const MS_POR_VENCER = 3 * 60 * 1000;
function programarChequeoPorVencer(createdAtMs) {
  const objetivo = (createdAtMs || Date.now()) + MS_POR_VENCER;
  const espera   = objetivo - Date.now();
  if (espera <= 0) {
    // Ya pasó el umbral: chequear de inmediato
    chequearPorVencer().catch(() => {});
    return;
  }
  // Programar para el momento exacto del cruce (+200ms de margen)
  setTimeout(() => chequearPorVencer().catch(() => {}), espera + 200);
}
// =========================
// EMAIL
// =========================
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
async function enviarEmail(to, subject, html) {
  try {
    await resend.emails.send({ from: "Asistiva Sodimac <onboarding@resend.dev>", to, subject, html });
    console.log(`✅ Email enviado a ${to}`);
  } catch (err) {
    console.error("❌ Error enviando email:", err.message);
  }
}
// =========================
// AWS S3 + PDF
// =========================
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const S3_BUCKET = process.env.AWS_S3_BUCKET || "helpcenter-sodimac-frontend";
const S3_FOLDER = process.env.AWS_S3_FOLDER || "informes";
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
               "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
async function generarPDFBuffer(desde, hasta, titulo, periodo) {
  const { rows: solis } = await pool.query(
    `SELECT estado, vendedor, pasillo, fila, rating, cancelacion_tipo,
            created_at, hora_atendida, en_curso_at
     FROM solicitudes WHERE created_at >= $1 AND created_at <= $2`,
    [desde, hasta]
  );
  const { rows: breaksRows } = await pool.query(
    `SELECT vendedor_nombre, inicio, fin FROM breaks
     WHERE inicio >= $1 AND inicio <= $2`,
    [desde, hasta]
  );
  const resueltas  = solis.filter(s => s.estado === "resuelta");
  const canceladas = solis.filter(s => s.estado === "cancelada");
  const ratings    = resueltas.filter(s => s.rating).map(s => Number(s.rating));
  const avgRating  = ratings.length
    ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
    : null;
  let tiemposEspera = [], tiemposAtencion = [];
  for (const s of resueltas) {
    if (s.created_at && s.en_curso_at) {
      const v = (new Date(s.en_curso_at) - new Date(s.created_at)) / 60000;
      if (v >= 0 && v < 120) tiemposEspera.push(v);
    }
    if (s.en_curso_at && s.hora_atendida) {
      const v = (new Date(s.hora_atendida) - new Date(s.en_curso_at)) / 60000;
      if (v >= 0 && v < 120) tiemposAtencion.push(v);
    }
  }
  const avgEspera = tiemposEspera.length
    ? (tiemposEspera.reduce((a, b) => a + b, 0) / tiemposEspera.length).toFixed(1)
    : "0";
  const byV = {};
  for (const s of solis) {
    const v = s.vendedor || "Sin asignar";
    if (!byV[v]) byV[v] = { atendidas: 0, canceladas: 0, esperas: [], atenciones: [], ratings: [] };
    if (s.estado === "resuelta") {
      byV[v].atendidas++;
      if (s.created_at && s.en_curso_at) {
        const d = (new Date(s.en_curso_at) - new Date(s.created_at)) / 60000;
        if (d >= 0 && d < 120) byV[v].esperas.push(d);
      }
      if (s.en_curso_at && s.hora_atendida) {
        const d = (new Date(s.hora_atendida) - new Date(s.en_curso_at)) / 60000;
        if (d >= 0 && d < 120) byV[v].atenciones.push(d);
      }
      if (s.rating) byV[v].ratings.push(Number(s.rating));
    }
    if (s.estado === "cancelada") byV[v].canceladas++;
  }
  const byP = {};
  for (const s of solis) {
    const p = s.pasillo || s.fila || "General";
    if (!byP[p]) byP[p] = { total: 0, resueltas: 0, canceladas: 0, esperas: [], byVendedor: {} };
    byP[p].total++;
    if (s.estado === "resuelta") {
      byP[p].resueltas++;
      if (s.created_at && s.en_curso_at) {
        const d = (new Date(s.en_curso_at) - new Date(s.created_at)) / 60000;
        if (d >= 0 && d < 120) byP[p].esperas.push(d);
      }
      const v = s.vendedor || "Sin asignar";
      byP[p].byVendedor[v] = (byP[p].byVendedor[v] || 0) + 1;
    }
    if (s.estado === "cancelada") byP[p].canceladas++;
  }
  const { rows: usuariosRows } = await pool.query(
    `SELECT nombre, apellidos, pasillos FROM usuarios WHERE rol='Vendedor' AND activo=true`
  );
  const vendedorPorPasillo = {};
  for (const u of usuariosRows) {
    const nombre = `${u.nombre} ${u.apellidos}`.trim();
    for (const p of (u.pasillos || [])) vendedorPorPasillo[p] = nombre;
  }
  const topPasillos = Object.entries(byP).sort((a, b) => b[1].total - a[1].total).slice(0, 6);
  const byBreak = {};
  for (const b of breaksRows) {
    const v = b.vendedor_nombre || "Sin asignar";
    if (!byBreak[v]) byBreak[v] = { count: 0, mins: 0 };
    byBreak[v].count++;
    const mins = (new Date(b.fin) - new Date(b.inicio)) / 60000;
    if (mins > 0) byBreak[v].mins += mins;
  }
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data",  c  => chunks.push(c));
    doc.on("end",   () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const PW = doc.page.width, ML = 40, MR = 40, W = PW - ML - MR;
    const AZUL  = "#0b5aa6", ROJO  = "#ef4444", VERDE = "#16a34a";
    const GRIS  = "#94a3b8", OSCURO = "#0f172a", CLARO = "#f8fafc", AMBER = "#b45309";
    function hline(y, color = "#f1f5f9", lw = 0.5) {
      doc.moveTo(ML, y).lineTo(ML + W, y).strokeColor(color).lineWidth(lw).stroke();
    }
    function secLabel(txt, y) {
      doc.fontSize(7).font("Helvetica-Bold").fillColor(GRIS).text(txt.toUpperCase(), ML, y, { characterSpacing: 1 });
    }
    function cell(txt, x, y, w, color, size = 9, font = "Helvetica", opts = {}) {
      doc.fontSize(size).font(font).fillColor(color).text(String(txt), x, y, { width: w, lineBreak: false, ...opts });
    }
    // Encabezado
    doc.rect(ML, 42, 3, 54).fill(AZUL);
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#e11d48").text("SODIMAC · HELPCENTER", ML + 10, 44, { characterSpacing: 1 });
    doc.fontSize(18).font("Helvetica-Bold").fillColor(OSCURO).text("Informe de Rendimiento", ML + 10, 54);
    doc.fontSize(9).font("Helvetica").fillColor(GRIS).text(`Período: ${periodo}`, ML + 10, 78);
    const fechaX = PW - MR - 105;
    doc.fontSize(7).font("Helvetica").fillColor(GRIS).text("GENERADO EL", fechaX, 44, { width: 105, align: "right" });
    doc.fontSize(11).font("Helvetica-Bold").fillColor(OSCURO).text(new Date().toLocaleDateString("es-CL"), fechaX, 55, { width: 105, align: "right" });
    doc.rect(ML, 103, W * 0.35, 2).fill(AZUL);
    doc.rect(ML + W * 0.35, 103, W * 0.65, 2).fill("#e5e7eb");
    // KPIs
    let y = 113;
    const kpis = [
      { label: "ATENDIDAS",      val: String(resueltas.length),  sub: "solicitudes",    color: AZUL,  bg: "#eff6ff" },
      { label: "CANCELADAS",     val: String(canceladas.length), sub: "solicitudes",    color: ROJO,  bg: "#fef2f2" },
      { label: "T. ESPERA PROM.",val: avgEspera,                 sub: "minutos",        color: VERDE, bg: "#f0fdf4" },
      { label: "CALIFICACIÓN",   val: avgRating ? avgRating : "—", sub: "de 4 estrellas", color: AMBER, bg: "#fffbeb" },
    ];
    const kw = (W - 6) / 4;
    kpis.forEach((k, i) => {
      const kx = ML + i * (kw + 2);
      doc.rect(kx, y, kw, 55).fill(k.bg);
      doc.rect(kx, y, kw, 2).fill(k.color);
      doc.fontSize(7).font("Helvetica-Bold").fillColor(k.color).text(k.label, kx + 8, y + 8, { width: kw - 12, characterSpacing: 0.4 });
      doc.fontSize(20).font("Helvetica-Bold").fillColor(OSCURO).text(k.val, kx + 8, y + 18, { width: kw - 12 });
      doc.fontSize(8).font("Helvetica").fillColor(GRIS).text(k.sub, kx + 8, y + 41, { width: kw - 12 });
    });
    // Tabla vendedores
    y += 68;
    secLabel("Rendimiento por vendedor", y); y += 13;
    const VC = [ML, ML+185, ML+233, ML+278, ML+340, ML+403];
    const VW = [180, 44, 42, 58, 58, 90];
    const VH = ["VENDEDOR", "ATEND.", "CANCEL.", "T. ESPERA", "T. ATENCIÓN", "CALIF."];
    doc.rect(ML, y, W, 16).fill(CLARO);
    VH.forEach((h, i) => doc.fontSize(7).font("Helvetica-Bold").fillColor(GRIS).text(h, VC[i], y + 5, { width: VW[i], characterSpacing: 0.4, lineBreak: false }));
    y += 16; hline(y);
    Object.entries(byV).forEach(([nombre, d]) => {
      const tE     = d.esperas.length    ? (d.esperas.reduce((a, b) => a + b, 0)    / d.esperas.length).toFixed(1)    + " min" : "—";
      const tA     = d.atenciones.length ? (d.atenciones.reduce((a, b) => a + b, 0) / d.atenciones.length).toFixed(1) + " min" : "—";
      const calNum = d.ratings.length    ? (d.ratings.reduce((a, b) => a + b, 0)    / d.ratings.length).toFixed(1)           : null;
      cell(nombre,                       VC[0], y+3, VW[0], OSCURO, 9,  "Helvetica-Bold");
      cell(String(d.atendidas),          VC[1], y+3, VW[1], AZUL,  10, "Helvetica-Bold");
      cell(String(d.canceladas),         VC[2], y+3, VW[2], GRIS,   9,  "Helvetica");
      cell(tE,                           VC[3], y+3, VW[3], "#64748b", 9, "Helvetica");
      cell(tA,                           VC[4], y+3, VW[4], "#64748b", 9, "Helvetica");
      cell(calNum ? calNum + " / 4" : "—", VC[5], y+3, VW[5], AMBER, 9, "Helvetica");
      y += 19; hline(y);
    });
    // Tabla pasillos
    y += 12;
    secLabel("Top pasillos", y); y += 13;
    const PC  = [ML, ML+68, ML+120, ML+178, ML+232, ML+300, ML+390];
    const PW2 = [64, 48, 54, 50, 64, 86, 105];
    const PH  = ["PASILLO","TOTAL","RESUELTAS","CANCEL.","T.ESPERA","MAS ATENDIO","VENDEDOR ASIG."];
    doc.rect(ML, y, W, 16).fill(CLARO);
    PH.forEach((h, i) => doc.fontSize(6.5).font("Helvetica-Bold").fillColor(GRIS).text(h, PC[i], y + 5, { width: PW2[i], characterSpacing: 0.3, lineBreak: false }));
    y += 16; hline(y);
    topPasillos.forEach(([pas, d]) => {
      const tEp        = d.esperas.length ? (d.esperas.reduce((a, b) => a + b, 0) / d.esperas.length).toFixed(1) + " min" : "—";
      const masAte     = Object.entries(d.byVendedor).sort((a, b) => b[1] - a[1])[0];
      const masAteNom  = masAte ? masAte[0] : "—";
      const vendAsig   = vendedorPorPasillo[pas] || "—";
      doc.rect(PC[0], y + 1, PW2[0] - 4, 16).fill("#f0f4f8");
      cell(pas,              PC[0]+4, y+4, PW2[0]-8, AZUL,      8,   "Helvetica-Bold");
      cell(String(d.total),  PC[1],   y+4, PW2[1],   "#4338ca", 10,  "Helvetica-Bold");
      cell(String(d.resueltas),  PC[2], y+4, PW2[2], VERDE,     10,  "Helvetica-Bold");
      cell(String(d.canceladas), PC[3], y+4, PW2[3], ROJO,       9,  "Helvetica");
      cell(tEp,              PC[4],   y+4, PW2[4],   "#64748b",  9,  "Helvetica");
      cell(masAteNom,        PC[5],   y+4, PW2[5],   OSCURO,    7.5, "Helvetica");
      cell(vendAsig,         PC[6],   y+4, PW2[6],   OSCURO,    7.5, "Helvetica");
      y += 21; hline(y);
    });
    if (topPasillos.length === 0) {
      doc.fontSize(9).font("Helvetica").fillColor(GRIS).text("Sin datos.", ML, y + 4);
      y += 18; hline(y);
    }
    // Tabla breaks
    y += 12;
    secLabel("Breaks por vendedor", y); y += 13;
    const BC = [ML, ML+220, ML+320, ML+415];
    const BW = [215, 96, 90, 90];
    const BH = ["VENDEDOR","N° BREAKS","TOTAL MINUTOS","PROM. POR BREAK"];
    doc.rect(ML, y, W, 16).fill(CLARO);
    BH.forEach((h, i) => doc.fontSize(7).font("Helvetica-Bold").fillColor(GRIS).text(h, BC[i], y + 5, { width: BW[i], characterSpacing: 0.4, lineBreak: false }));
    y += 16; hline(y);
    const breakEntries = Object.entries(byBreak);
    if (breakEntries.length === 0) {
      doc.fontSize(9).font("Helvetica").fillColor(GRIS).text("Sin breaks registrados.", ML, y + 4);
      y += 18;
    } else {
      breakEntries.forEach(([nombre, d]) => {
        const prom = d.count > 0 ? Math.round(d.mins / d.count) + " min" : "—";
        cell(nombre,                      BC[0], y+3, BW[0], OSCURO,    9,  "Helvetica-Bold");
        cell(String(d.count),             BC[1], y+3, BW[1], "#64748b", 9,  "Helvetica");
        cell(Math.round(d.mins) + " min", BC[2], y+3, BW[2], AZUL,     10, "Helvetica-Bold");
        cell(prom,                        BC[3], y+3, BW[3], "#64748b", 9,  "Helvetica");
        y += 19; hline(y);
      });
    }
    // Pie de página
    y += 14; hline(y, "#f1f5f9", 0.5); y += 8;
    doc.fontSize(7).font("Helvetica").fillColor("#e2e8f0").text("DOCUMENTO CONFIDENCIAL · HELPCENTER SODIMAC", ML, y, { characterSpacing: 0.5 });
    doc.fontSize(7).font("Helvetica").fillColor("#e2e8f0").text("Pagina 1 de 1", ML, y, { width: W, align: "right" });
    doc.end();
  });
}
async function generarYGuardarInforme(anio, mes) {
  try {
    const desde     = new Date(anio, mes - 1, 1).toISOString();
    const hasta     = new Date(anio, mes, 0, 23, 59, 59).toISOString();
    const nombreMes = `${MESES[mes - 1]} ${anio}`;
    const periodo   = `01-${String(mes).padStart(2,"0")}-${anio} al ${new Date(anio,mes,0).getDate()}-${String(mes).padStart(2,"0")}-${anio}`;
    const pdfBuffer = await generarPDFBuffer(desde, hasta, nombreMes, periodo);
    const s3Key     = `${S3_FOLDER}/informe_${anio}-${String(mes).padStart(2,"0")}.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Body: pdfBuffer, ContentType: "application/pdf" }));
    const s3Url = `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}`;
    await pool.query(
      `INSERT INTO informes_mensuales (anio,mes,nombre,s3_key,s3_url,generado_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (anio,mes) DO UPDATE SET s3_key=$4,s3_url=$5,generado_at=NOW()`,
      [anio, mes, nombreMes, s3Key, s3Url]
    );
    return { ok: true, url: s3Url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
// Tareas programadas (cada hora)
setInterval(async () => {
  const hoy       = new Date();
  const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  // Generar informe mensual el último día del mes a las 23h
  if (hoy.getDate() === ultimoDia && hoy.getHours() === 23) {
    const { rows } = await pool.query(
      `SELECT id FROM informes_mensuales WHERE anio=$1 AND mes=$2`,
      [hoy.getFullYear(), hoy.getMonth() + 1]
    );
    if (rows.length === 0) await generarYGuardarInforme(hoy.getFullYear(), hoy.getMonth() + 1);
  }
  // Limpieza diaria: cerrar cualquier solicitud activa de un día anterior
  // (en zona horaria Chile). Se ejecuta en CADA tick (cada hora) y solo actúa
  // si encuentra solicitudes viejas — así no depende de acertar una ventana
  // horaria exacta ni de la hora del servidor (UTC). Garantiza que al cambiar
  // el día en Chile, las solicitudes de ayer queden cerradas.
  try {
    // Usamos estado 'expirada' (NO 'cancelada') para que estas solicitudes del
    // día anterior NO cuenten en el contador de canceladas. Y NO tocamos
    // updated_at, para que tampoco cuenten como actividad de hoy. Simplemente
    // dejan de estar activas y desaparecen de todas las vistas.
    const { rowCount } = await pool.query(
      `UPDATE solicitudes SET estado='expirada'
       WHERE estado IN ('pendiente','asignada','en_curso')
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
    );
    if (rowCount > 0) {
      console.log(`🧹 Limpieza diaria: ${rowCount} solicitudes del día anterior expiradas`);
      io.emit('solicitud_estado', { tipo: 'limpieza_diaria' });
    }
  } catch (err) {
    console.error('❌ Error limpieza diaria:', err.message);
  }
}, 60 * 60 * 1000);
// =========================
// CORS
// =========================
const allowedOrigins = [
  "https://grupovhmc.cl",
  "https://www.grupovhmc.cl",
  "https://app.grupovhmc.cl",
  "http://localhost:5173",
  "http://localhost:3000",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS bloqueado para origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.options("*", cors());
// Middleware multipart (formidable) — ANTES de express.json()
app.use((req, res, next) => {
  if (req.headers["content-type"]?.includes("multipart/form-data")) {
    const form = formidable({ multiples: false, maxFileSize: 5 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) return next(err);
      req.body  = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      req.files = Object.fromEntries(Object.entries(files).map(([k, v])  => [k, Array.isArray(v) ? v[0] : v]));
      next();
    });
  } else {
    next();
  }
});
app.use(express.json());
// Evitar que el navegador/CDN cachee respuestas de la API (estados desactualizados)
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
});
app.use(express.static(path.join(__dirname, "public")));
// =========================
// CONSTANTES Y HELPERS
// =========================
const ESTADOS = {
  PENDIENTE: "pendiente", ASIGNADA: "asignada", EN_CURSO: "en_curso",
  RESUELTA:  "resuelta",  CANCELADA: "cancelada",
};
function normalizeEstado(raw) {
  const e = (raw || "").toString().trim().toLowerCase();
  if (e === "en curso" || e === "encurso" || e === "en_curso") return ESTADOS.EN_CURSO;
  if (e === "resuelta"  || e === "resuelto")                   return ESTADOS.RESUELTA;
  if (e === "cancelado" || e === "cancelada")                  return ESTADOS.CANCELADA;
  if (e === "asignada"  || e === "asignado")                   return ESTADOS.ASIGNADA;
  if (e === "pendiente")                                        return ESTADOS.PENDIENTE;
  return e;
}
let contadorTickets = 0;
(async () => {
  try {
    // FIX duplicate key: basar el contador en el MAYOR número ya emitido en
    // TODA la tabla (la constraint UNIQUE numero_qr aplica a toda la tabla,
    // no solo a hoy). Si limitáramos a "hoy", el contador arrancaría bajo y
    // chocaría con números A-NNN de días anteriores que siguen en la tabla.
    const result = await pool.query(
      `SELECT COALESCE(MAX(CAST(SPLIT_PART(numero_qr,'-',2) AS INTEGER)),0) AS maxnum
       FROM solicitudes
       WHERE numero_qr LIKE 'A-%'`
    );
    contadorTickets = parseInt(result.rows[0].maxnum || 0);
    console.log(`🔢 Contador de tickets inicializado en ${contadorTickets}`);
  } catch (err) {
    console.error("⚠️ No se pudo sincronizar contador:", err.message);
  }
})();
io.on("connection", socket => {
  console.log("✅ Cliente Socket conectado:", socket.id);
  socket.on("disconnect", () => console.log("🔌 Cliente Socket desconectado:", socket.id));
});
// =========================
// ASIGNACIÓN INTELIGENTE
// =========================
const UMBRAL_SATURACION = 4;
async function calcularCargaVendedor(vendedorId, vendedorNombre) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM solicitudes
     WHERE estado IN ('pendiente','asignada','en_curso')
       AND (vendedor_id = $1 OR vendedor = $2)`,
    [vendedorId, vendedorNombre]
  );
  return parseInt(result.rows[0].count || 0);
}
async function obtenerVendedoresDisponibles() {
  const result = await pool.query(
    `SELECT id, nombre, apellidos, pasillos, estado
     FROM usuarios WHERE rol='Vendedor' AND activo=true AND estado='Activo'`
  );
  return result.rows;
}
async function elegirVendedor(pasilloSolicitud) {
  const vendedores = await obtenerVendedoresDisponibles();
  if (vendedores.length === 0) return null;
  const conCarga = await Promise.all(vendedores.map(async v => {
    const nombre = `${v.nombre} ${v.apellidos}`.trim();
    const carga  = await calcularCargaVendedor(v.id, nombre);
    return { ...v, nombre, carga };
  }));
  const esGeneral = !pasilloSolicitud || pasilloSolicitud.toLowerCase() === "general";
  let elegido = null;
  if (!esGeneral) {
    const vp = conCarga.find(v => (Array.isArray(v.pasillos) ? v.pasillos : []).includes(pasilloSolicitud));
    if (vp && vp.carga < UMBRAL_SATURACION) elegido = vp;
  }
  if (!elegido) elegido = conCarga.reduce((mejor, v) => v.carga < mejor.carga ? v : mejor);
  return elegido;
}
async function redistribuirSaturados() {
  const vendedores = await obtenerVendedoresDisponibles();
  if (vendedores.length < 2) return;
  const conCarga = await Promise.all(vendedores.map(async v => {
    const nombre = `${v.nombre} ${v.apellidos}`.trim();
    const carga  = await calcularCargaVendedor(v.id, nombre);
    return { ...v, nombre, carga };
  }));
  for (const vendedor of conCarga) {
    if (vendedor.carga < UMBRAL_SATURACION) continue;
    const { rows: aReasignar } = await pool.query(
      `SELECT id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
              vendedor_id AS "vendedorId", created_at AS "createdAt"
       FROM solicitudes
       WHERE estado IN ('pendiente','asignada')
         AND (vendedor_id=$1 OR vendedor=$2)
         AND updated_at < NOW() - INTERVAL '30 seconds'
       ORDER BY CASE WHEN (NOW()-created_at)>INTERVAL '3 minutes' THEN 0 ELSE 1 END, created_at ASC`,
      [vendedor.id, vendedor.nombre]
    );
    for (const sol of aReasignar) {
      const cargaActual = await calcularCargaVendedor(vendedor.id, vendedor.nombre);
      if (cargaActual < UMBRAL_SATURACION) break;
      const disponibles = conCarga.filter(v => v.id !== vendedor.id && v.carga < UMBRAL_SATURACION);
      if (disponibles.length === 0) break;
      const receptor = disponibles.reduce((mejor, v) => v.carga < mejor.carga ? v : mejor);
      const { rows: updated } = await pool.query(
        `UPDATE solicitudes SET vendedor=$1, vendedor_id=$2, estado='asignada', updated_at=NOW()
         WHERE id=$3
         RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
           vendedor_id AS "vendedorId", rating, cancelacion_tipo AS "cancelacionTipo",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [receptor.nombre, receptor.id, sol.id]
      );
      if (updated.length > 0) {
        receptor.carga += 1;
        vendedor.carga -= 1;
        const solEmit = safeRow(updated[0]);
        io.emit("solicitud_asignada", solEmit);
        // Notificar al vendedor receptor de la redistribución automática
        try {
          const { rows: cargaR } = await pool.query(
            `SELECT COUNT(*) AS cnt FROM solicitudes
             WHERE vendedor_id=$1 AND estado IN ('pendiente','asignada','en_curso')`,
            [receptor.id]
          );
          const totalR = Math.max(1, Number(cargaR[0]?.cnt || 1));
          await sendPush(
            receptor.id,
            '🛒 Nueva solicitud asignada',
            `Pasillo ${solEmit.pasillo || solEmit.fila || 'General'} · N° ${solEmit.numeroQR}. Tienes ${totalR} solicitud${totalR > 1 ? 'es' : ''} activa${totalR > 1 ? 's' : ''}.`,
            { tipo: 'nueva_solicitud', solicitudId: solEmit.id }
          );
        } catch (e) { console.error('❌ Push redistribución:', e.message); }
      }
    }
  }
}
// =========================
// HEALTH
// =========================
app.get("/health",       (req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, db: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// =========================
// SOLICITUDES (dashboard web)
// =========================
app.get("/solicitudes", async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    let query, params;
    if (desde && hasta) {
      query  = `SELECT id, numero_qr AS "numeroQR", fila, pasillo, nivel, qr_id AS "qrId",
                       estado, vendedor, vendedor_id AS "vendedorId", rating,
                       cancelacion_tipo AS "cancelacionTipo", hora_atendida AS "horaAtendida",
                       created_at AS "createdAt", updated_at AS "updatedAt", en_curso_at AS "enCursoAt"
                FROM solicitudes WHERE created_at >= $1 AND created_at <= $2
                ORDER BY created_at DESC LIMIT 2000`;
      params = [desde, hasta];
    } else if (desde) {
      query  = `SELECT id, numero_qr AS "numeroQR", fila, pasillo, nivel, qr_id AS "qrId",
                       estado, vendedor, vendedor_id AS "vendedorId", rating,
                       cancelacion_tipo AS "cancelacionTipo", hora_atendida AS "horaAtendida",
                       created_at AS "createdAt", updated_at AS "updatedAt", en_curso_at AS "enCursoAt"
                FROM solicitudes WHERE created_at >= $1
                ORDER BY created_at DESC LIMIT 2000`;
      params = [desde];
    } else {
      query  = `SELECT id, numero_qr AS "numeroQR", fila, pasillo, nivel, qr_id AS "qrId",
                       estado, vendedor, vendedor_id AS "vendedorId", rating,
                       cancelacion_tipo AS "cancelacionTipo", hora_atendida AS "horaAtendida",
                       created_at AS "createdAt", updated_at AS "updatedAt", en_curso_at AS "enCursoAt"
                FROM solicitudes ORDER BY created_at DESC LIMIT 200`;
      params = [];
    }
    const result = await pool.query(query, params);
    res.json(result.rows.map(safeRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/atencion", async (req, res) => {
  const { punto, p, n, q } = req.body || {};
  const pasillo = p || null;
  const nivel   = n ? `N${n}` : null;
  const qr_id   = q || null;
  const fila    = pasillo || punto || "General";
  const id      = Date.now();
  let numero;
  try {
    // FIX duplicate key: insertar reintentando si el número ya existe. Al
    // primer choque, RESINCRONIZAR el contador con el MAX real de la tabla
    // (cubre el caso de la variable en memoria desincronizada tras choques o
    // números viejos altos). Luego sigue avanzando de 1 en 1.
    let insertado = false;
    for (let intento = 0; intento < 50 && !insertado; intento++) {
      contadorTickets += 1;
      numero = `A-${String(contadorTickets).padStart(3, "0")}`;
      try {
        await pool.query(
          `INSERT INTO solicitudes (id,numero_qr,fila,pasillo,nivel,qr_id,estado,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [id, numero, fila, pasillo, nivel, qr_id, ESTADOS.PENDIENTE]
        );
        insertado = true;
      } catch (eIns) {
        if (eIns.code === "23505" && /numero_qr/.test(eIns.constraint || eIns.detail || "")) {
          console.log(`⚠️ numero_qr ${numero} ya existe, reintentando...`);
          // En el primer choque, resincronizar con el MAX real de toda la
          // tabla para saltar de golpe por encima de cualquier número viejo.
          if (intento === 0) {
            try {
              const { rows: mx } = await pool.query(
                `SELECT COALESCE(MAX(CAST(SPLIT_PART(numero_qr,'-',2) AS INTEGER)),0) AS maxnum
                 FROM solicitudes WHERE numero_qr LIKE 'A-%'`
              );
              const maxReal = parseInt(mx[0]?.maxnum || 0);
              if (maxReal >= contadorTickets) contadorTickets = maxReal;
            } catch (e) { /* si falla, seguimos avanzando de 1 en 1 */ }
          }
          continue;
        }
        throw eIns;
      }
    }
    if (!insertado) throw new Error("No se pudo generar un número de atención único");
    // Programar la notificación de "por vencer" para el instante EXACTO en que
    // esta solicitud cumpla 3 minutos (id = Date.now() = momento de creación).
    programarChequeoPorVencer(id);
    const nuevaSolicitud = {
      id: String(id), numeroQR: numero, fila, pasillo, nivel, qr_id,
      createdAt: new Date().toISOString(), estado: ESTADOS.PENDIENTE,
      vendedor: null, rating: null,
    };
    io.emit("solicitud_nueva", nuevaSolicitud);
    elegirVendedor(pasillo || fila).then(async vendedorElegido => {
      if (!vendedorElegido) return;
      const { rows } = await pool.query(
        `UPDATE solicitudes SET vendedor=$1, vendedor_id=$2, estado='asignada', updated_at=NOW()
         WHERE id=$3
         RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
           vendedor_id AS "vendedorId", rating, cancelacion_tipo AS "cancelacionTipo",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [vendedorElegido.nombre, vendedorElegido.id, id]
      );
      if (rows.length > 0) {
        const sol = safeRow(rows[0]);
        io.emit("solicitud_asignada", sol);
        await redistribuirSaturados();
        // Notificar al vendedor
        const { rows: cargaRows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM solicitudes
           WHERE vendedor_id=$1 AND estado IN ('pendiente','asignada','en_curso')
             AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`,
          [vendedorElegido.id]
        );
        const totalActivas = Number(cargaRows[0]?.cnt || 1);
        await sendPush(
          vendedorElegido.id,
          '🛒 Nueva solicitud asignada',
          `Pasillo ${sol.pasillo || sol.fila || 'General'} · N° ${sol.numeroQR}. Tienes ${totalActivas} solicitud${totalActivas > 1 ? 'es' : ''} activa${totalActivas > 1 ? 's' : ''}.`,
          { tipo: 'nueva_solicitud', solicitudId: sol.id }
        );
      }
    }).catch(err => console.error("❌ Error asignación:", err.message));
    return res.json({ id: String(id), numero, createdAt: nuevaSolicitud.createdAt, vendedor: null, estado: ESTADOS.PENDIENTE });
  } catch (err) {
    console.error("❌ Error creando solicitud:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/atencion/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, numero_qr AS numero, vendedor, estado, created_at AS "createdAt", rating, fila AS punto
       FROM solicitudes WHERE id=$1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    res.json(safeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/solicitudes/:id/asignar", async (req, res) => {
  let { vendedor, vendedorId } = req.body || {};
  try {
    if (!vendedorId && vendedor) {
      const parts = vendedor.trim().split(" ");
      const { rows: found } = await pool.query(
        `SELECT id FROM usuarios WHERE nombre=$1 AND apellidos=$2`,
        [parts[0], parts.slice(1).join(" ")]
      );
      if (found.length > 0) vendedorId = found[0].id;
    }
    const result = await pool.query(
      `UPDATE solicitudes SET vendedor=$1, vendedor_id=$2, estado=$3, updated_at=NOW()
       WHERE id=$4
       RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
         vendedor_id AS "vendedorId", rating, cancelacion_tipo AS "cancelacionTipo",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [vendedor || null, vendedorId || null, ESTADOS.ASIGNADA, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    const emitSol = safeRow(result.rows[0]);
    const vIdFinal = Number(vendedorId) || emitSol.vendedorId;
    io.emit("solicitud_asignada", {
      ...emitSol,
      vendedorId:  vIdFinal,
      vendedor_id: vIdFinal,
    });
    // Notificar por push al vendedor (igual que en reasignación manual).
    // Este endpoint lo usa el dashboard web; antes solo emitía socket (sonido
    // in-app) pero no enviaba la notificación del sistema.
    if (vIdFinal) {
      try {
        const { rows: cargaAsig } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM solicitudes
           WHERE vendedor_id=$1 AND estado IN ('pendiente','asignada','en_curso')`,
          [vIdFinal]
        );
        const totalAsig = Math.max(1, Number(cargaAsig[0]?.cnt || 1));
        console.log(`🔁 Asignando (dashboard) solicitud ${emitSol.id} a vendedor ${vIdFinal}`);
        await sendPush(
          vIdFinal,
          '🛒 Nueva solicitud asignada',
          `Pasillo ${emitSol.pasillo || emitSol.fila || 'General'} · N° ${emitSol.numeroQR}. Tienes ${totalAsig} solicitud${totalAsig > 1 ? 'es' : ''} activa${totalAsig > 1 ? 's' : ''}.`,
          { tipo: 'nueva_solicitud', solicitudId: emitSol.id }
        );
      } catch (e) { console.error('❌ Push asignación dashboard:', e.message); }
    }
    redistribuirSaturados().catch(err => console.error("❌", err.message));
    res.json(emitSol);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/solicitudes/:id/estado", async (req, res) => {
  const { estado, cancelacionTipo } = req.body || {};
  const nuevoEstado = normalizeEstado(estado);
  try {
    const result = await pool.query(
      `UPDATE solicitudes
       SET estado           = $1::varchar,
           cancelacion_tipo = CASE WHEN $1::varchar='cancelada' THEN $2::varchar ELSE cancelacion_tipo END,
           hora_atendida    = CASE WHEN $1::varchar='resuelta' AND hora_atendida IS NULL THEN NOW() ELSE hora_atendida END,
           en_curso_at      = CASE WHEN $1::varchar='en_curso'  AND en_curso_at  IS NULL THEN NOW() ELSE en_curso_at  END,
           updated_at       = NOW()
       WHERE id=$3
       RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
         vendedor_id AS "vendedorId", rating, cancelacion_tipo AS "cancelacionTipo",
         hora_atendida AS "horaAtendida", en_curso_at AS "enCursoAt",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [nuevoEstado, cancelacionTipo || "cliente", req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    io.emit("solicitud_estado", safeRow(result.rows[0]));
    if (nuevoEstado === ESTADOS.RESUELTA || nuevoEstado === ESTADOS.CANCELADA) redistribuirSaturados().catch(() => {});
    res.json(safeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/atencion/:id/estado", async (req, res) => {
  const { estado, cancelacionTipo } = req.body || {};
  const nuevoEstado = normalizeEstado(estado) || ESTADOS.CANCELADA;
  try {
    const result = await pool.query(
      `UPDATE solicitudes
       SET estado           = $1::varchar,
           cancelacion_tipo = CASE WHEN $1::varchar='cancelada' THEN $2::varchar ELSE cancelacion_tipo END,
           updated_at       = NOW()
       WHERE id=$3 RETURNING id, estado, updated_at AS "updatedAt"`,
      [nuevoEstado, cancelacionTipo || "cliente", req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    io.emit("solicitud_estado", safeRow(result.rows[0]));
    res.json({ ok: true, id: String(result.rows[0].id), estado: result.rows[0].estado });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/atencion/:id/calificacion", async (req, res) => {
  const rating = Number(req.body?.rating);
  if (![1, 2, 3, 4].includes(rating)) return res.status(400).json({ error: "rating inválido" });
  try {
    const result = await pool.query(
      `UPDATE solicitudes SET rating=$1, updated_at=NOW() WHERE id=$2 RETURNING id, rating`,
      [rating, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    await pool.query(
      `INSERT INTO calificaciones (solicitud_id,puntuacion) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, rating]
    );
    io.emit("solicitud_calificada", { id: String(result.rows[0].id), rating });
    res.json({ ok: true, id: String(result.rows[0].id), rating });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/solicitudes/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE solicitudes SET estado='cancelada', updated_at=NOW()
       WHERE id=$1 RETURNING id, estado`, [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    io.emit("solicitud_estado", safeRow(rows[0]));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// USUARIOS
// =========================
app.get("/usuarios", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos
       FROM usuarios ORDER BY id`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/usuarios", async (req, res) => {
  const { nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos, password, must_change_password } = req.body;
  try {
    const hash = await bcrypt.hash(password || "123456", 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nombre,apellidos,rut,email,telefono,rol,activo,estado,pasillos,password_hash,must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [nombre, apellidos, rut, email, telefono, rol, activo ?? true, estado ?? "Activo", pasillos ?? [], hash, must_change_password ?? true]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/usuarios/:id", async (req, res) => {
  const { nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos } = req.body;
  try {
    const result = await pool.query(
      `UPDATE usuarios SET nombre=$1,apellidos=$2,rut=$3,email=$4,telefono=$5,
       rol=$6,activo=$7,estado=$8,pasillos=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/usuarios/:id", async (req, res) => {
  try {
    const { rows: uRows } = await pool.query("SELECT email FROM usuarios WHERE id=$1", [req.params.id]);
    await pool.query("DELETE FROM usuarios WHERE id=$1", [req.params.id]);
    if (uRows.length > 0) {
      await pool.query("DELETE FROM solicitudes_cuenta WHERE LOWER(email)=LOWER($1)", [uRows[0].email]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// BREAKS (dashboard web)
// =========================
app.get("/api/breaks", async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    let query = "SELECT * FROM breaks";
    const params = [];
    if (desde && hasta) { query += " WHERE inicio>=$1 AND inicio<=$2"; params.push(desde, hasta); }
    else if (desde)     { query += " WHERE inicio>=$1"; params.push(desde); }
    query += " ORDER BY inicio DESC";
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: "Error al obtener breaks" }); }
});
app.post("/api/breaks", async (req, res) => {
  try {
    const { vendedor_id, vendedor_nombre, inicio, fin, tipo } = req.body || {};
    if (!vendedor_nombre || !inicio || !fin) return res.status(400).json({ error: "Faltan campos" });
    const { rows } = await pool.query(
      `INSERT INTO breaks (vendedor_id,vendedor_nombre,inicio,fin,tipo)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [vendedor_id || null, vendedor_nombre, inicio, fin, tipo || "break"]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: "Error al guardar break" }); }
});
// =========================
// INFORMES
// =========================
app.get("/api/informes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, anio, mes, nombre, s3_url, generado_at
       FROM informes_mensuales ORDER BY anio DESC, mes DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/informes/generar", async (req, res) => {
  const hoy  = new Date();
  const anio = Number(req.body?.anio || hoy.getFullYear());
  const mes  = Number(req.body?.mes  || hoy.getMonth() + 1);
  const result = await generarYGuardarInforme(anio, mes);
  if (result.ok) res.json(result); else res.status(500).json(result);
});
app.get("/api/informes/descargar", async (req, res) => {
  try {
    const { range } = req.query;
    const hoy = new Date();
    let desde, hasta, titulo, periodo;
    if (range === "HOY") {
      desde  = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).toISOString();
      hasta  = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 23, 59, 59).toISOString();
      titulo = "Informe — Hoy"; periodo = hoy.toLocaleDateString("es-CL");
    } else if (range === "D7") {
      const ini = new Date(hoy.getTime() - 7*24*60*60*1000);
      desde = ini.toISOString(); hasta = hoy.toISOString();
      titulo = "Informe — Últimos 7 días";
      periodo = `${ini.toLocaleDateString("es-CL")} al ${hoy.toLocaleDateString("es-CL")}`;
    } else if (range === "D30") {
      const ini = new Date(hoy.getTime() - 30*24*60*60*1000);
      desde = ini.toISOString(); hasta = hoy.toISOString();
      titulo = "Informe — Últimos 30 días";
      periodo = `${ini.toLocaleDateString("es-CL")} al ${hoy.toLocaleDateString("es-CL")}`;
    } else if (range === "ANUAL") {
      const ini = new Date(hoy.getFullYear(), 0, 1);
      desde = ini.toISOString(); hasta = hoy.toISOString();
      titulo = `Informe — ${hoy.getFullYear()}`;
      periodo = `01-01-${hoy.getFullYear()} al ${hoy.toLocaleDateString("es-CL")}`;
    } else {
      return res.status(400).json({ error: "range inválido" });
    }
    const pdfBuffer = await generarPDFBuffer(desde, hasta, titulo, periodo);
    const fecha = hoy.toISOString().slice(0, 10);
    const nombreMap = {
      HOY:   `informe_diario_${fecha}`,
      D7:    `informe_semanal_${fecha}`,
      D30:   `informe_30dias_${fecha}`,
      ANUAL: `informe_anual_${hoy.getFullYear()}`,
    };
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${nombreMap[range] || 'informe'}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// AUTH
// =========================
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email y contraseña requeridos" });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM usuarios WHERE LOWER(email)=LOWER($1) AND activo=true", [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Usuario no encontrado" });
    const usuario = rows[0];
    if (!usuario.password_hash) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE usuarios SET password_hash=$1 WHERE id=$2", [hash, usuario.id]);
      const { password_hash: _ph, ...safe } = { ...usuario, password_hash: hash };
      return res.json({ ok: true, usuario: safe });
    }
    const match = await bcrypt.compare(password, usuario.password_hash);
    if (!match) return res.status(401).json({ error: "Contraseña incorrecta" });
    const { password_hash, ...usuarioSafe } = usuario;
    res.json({ ok: true, usuario: { ...usuarioSafe, must_change_password: usuarioSafe.must_change_password || false } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/auth/reset-password/:id", async (req, res) => {
  try {
    const hash = await bcrypt.hash("123456", 10);
    await pool.query(
      `UPDATE usuarios SET password_hash=$1, must_change_password=true WHERE id=$2`,
      [hash, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/auth/change-password", async (req, res) => {
  const { userId, nuevaPassword } = req.body || {};
  if (!userId || !nuevaPassword) return res.status(400).json({ error: "Faltan datos" });
  if (nuevaPassword.length < 6)  return res.status(400).json({ error: "Mínimo 6 caracteres" });
  try {
    const hash = await bcrypt.hash(nuevaPassword, 10);
    await pool.query(
      `UPDATE usuarios SET password_hash=$1, must_change_password=false WHERE id=$2`,
      [hash, userId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/auth/recuperar", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email requerido" });
  try {
    const { rows } = await pool.query(
      "SELECT id FROM usuarios WHERE LOWER(email)=LOWER($1) AND activo=true", [email]
    );
    if (rows.length === 0) return res.status(404).json({ error: "No existe un usuario con ese correo" });
    const codigo = Math.floor(1000 + Math.random() * 9000).toString();
    const expira = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      "INSERT INTO codigos_recuperacion (email,codigo,expira_at) VALUES ($1,$2,$3)",
      [email.toLowerCase(), codigo, expira]
    );
    await enviarEmail(
      email,
      "Código de recuperación — SODIMAC",
      `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
       <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
         <tr><td align="center">
           <table width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
             <tr><td align="center" style="padding:28px 32px 20px;">
               <div style="font-size:26px;font-weight:900;color:#E8203A;letter-spacing:1px;">SODIMAC</div>
             </td></tr>
             <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #E2E8F0;margin:0;"></td></tr>
             <tr><td style="padding:28px 32px 20px;">
               <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#1E293B;">Recuperación de contraseña</p>
               <p style="margin:0 0 24px;font-size:14px;color:#64748B;line-height:1.6;">
                 Usa este código para restablecer tu contraseña. Expira en <strong>15 minutos</strong>.
               </p>
               <div style="background:#2563EB;border-radius:10px;padding:22px;text-align:center;margin-bottom:24px;">
                 <span style="font-size:36px;font-weight:900;color:#ffffff;letter-spacing:14px;">${codigo}</span>
               </div>
               <p style="margin:0;font-size:12px;color:#94A3B8;text-align:center;">
                 Si no solicitaste este código, ignora este mensaje.
               </p>
             </td></tr>
             <tr><td style="padding:16px 32px 24px;border-top:1px solid #F1F5F9;text-align:center;">
               <span style="font-size:11px;color:#94A3B8;">Powered by </span>
               <span style="font-size:13px;font-weight:900;color:#1E293B;letter-spacing:0.5px;">ASISTIVA</span>
               <span style="font-size:10px;color:#94A3B8;"> · Atención Activa Inteligente</span>
             </td></tr>
           </table>
         </td></tr>
       </table></body></html>`
    );
    res.json({ ok: true, message: "Código enviado al correo" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/auth/verificar-codigo", async (req, res) => {
  const { email, codigo } = req.body || {};
  try {
    const { rows } = await pool.query(
      `SELECT * FROM codigos_recuperacion
       WHERE LOWER(email)=LOWER($1) AND codigo=$2 AND usado=false AND expira_at>NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email, codigo]
    );
    if (rows.length === 0) return res.status(400).json({ error: "Código inválido o expirado" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/auth/nueva-password", async (req, res) => {
  const { email, codigo, password } = req.body || {};
  try {
    const { rows } = await pool.query(
      `SELECT * FROM codigos_recuperacion
       WHERE LOWER(email)=LOWER($1) AND codigo=$2 AND usado=false AND expira_at>NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email, codigo]
    );
    if (rows.length === 0) return res.status(400).json({ error: "Código inválido o expirado" });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1 WHERE LOWER(email)=LOWER($2)", [hash, email]);
    await pool.query("UPDATE codigos_recuperacion SET usado=true WHERE id=$1", [rows[0].id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// SOLICITUDES DE CUENTA
// =========================
app.get("/api/solicitudes-cuenta", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,nombre,apellidos,rut,email,telefono,rol,estado,created_at FROM solicitudes_cuenta ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/solicitudes-cuenta", async (req, res) => {
  const { nombre, apellidos, rut, email, telefono, rol, password } = req.body || {};
  if (!nombre || !email || !password) return res.status(400).json({ error: "Nombre, email y contraseña son requeridos" });
  try {
    const { rows: existe } = await pool.query(
      "SELECT id FROM usuarios WHERE LOWER(email)=LOWER($1)", [email]
    );
    if (existe.length > 0) return res.status(409).json({ error: "Ya existe un usuario con ese correo" });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO solicitudes_cuenta (nombre,apellidos,rut,email,telefono,rol,password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [nombre, apellidos || "", rut || "", email, telefono || "", rol || "Vendedor", hash]
    );
    io.emit("solicitud_cuenta_nueva", { id: rows[0].id, nombre, email });
    res.json({ ok: true, message: "Solicitud enviada." });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Ya existe una solicitud con ese correo" });
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/solicitudes-cuenta/:id/aprobar", async (req, res) => {
  try {
    const { rows: sol } = await pool.query("SELECT * FROM solicitudes_cuenta WHERE id=$1", [req.params.id]);
    if (sol.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    const s = sol[0];
    const { rows: existe } = await pool.query("SELECT id FROM usuarios WHERE LOWER(email)=LOWER($1)", [s.email]);
    if (existe.length > 0) {
      await pool.query("UPDATE solicitudes_cuenta SET estado='aprobada' WHERE id=$1", [req.params.id]);
      io.emit("solicitud_cuenta_actualizada", { id: req.params.id, estado: "aprobada" });
      return res.json({ ok: true, warning: "Usuario ya existía" });
    }
    await pool.query(
      `INSERT INTO usuarios (nombre,apellidos,rut,email,telefono,rol,activo,estado,pasillos,password_hash,must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true,'Activo','{}',$7,true)`,
      [s.nombre, s.apellidos, s.rut, s.email, s.telefono, s.rol, s.password_hash]
    );
    await pool.query("UPDATE solicitudes_cuenta SET estado='aprobada' WHERE id=$1", [req.params.id]);
    await enviarEmail(s.email, "Tu cuenta fue aprobada — SODIMAC",
      `<p>Hola ${s.nombre}, ya puedes ingresar con tu correo y la contraseña que registraste.</p>`
    );
    io.emit("solicitud_cuenta_actualizada", { id: req.params.id, estado: "aprobada" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/solicitudes-cuenta/:id/rechazar", async (req, res) => {
  try {
    const { rows: sol } = await pool.query("SELECT * FROM solicitudes_cuenta WHERE id=$1", [req.params.id]);
    if (sol.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    await pool.query("UPDATE solicitudes_cuenta SET estado='rechazada' WHERE id=$1", [req.params.id]);
    io.emit("solicitud_cuenta_actualizada", { id: req.params.id, estado: "rechazada" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// QR
// =========================
app.get("/api/qr", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM qr_generados ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/qr/generar", async (req, res) => {
  const pasillo      = req.body?.pasillo     || req.fields?.pasillo;
  const nivel        = req.body?.nivel       || req.fields?.nivel;
  const titulo       = req.body?.titulo      || req.fields?.titulo      || "";
  const descripcion  = req.body?.descripcion || req.fields?.descripcion || "";
  const imagen_url   = req.body?.imagen_url  || "";
  const imagen_base64 = req.body?.imagen_base64 || "";
  if (!pasillo || !nivel) return res.status(400).json({ error: "Pasillo y nivel requeridos" });
  try {
    const url        = `https://www.grupovhmc.cl/atencion/?p=${encodeURIComponent(pasillo)}&n=${encodeURIComponent(nivel.replace("N",""))}`;
    const pngBase64  = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    const { rows } = await pool.query(
      `INSERT INTO qr_generados (pasillo,nivel,url,titulo,descripcion,imagen_url,imagen_data,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *`,
      [pasillo, nivel, url, titulo, descripcion, imagen_url || "", imagen_base64 || ""]
    );
    res.json({ ok: true, qr: rows[0], pngBase64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/qr/:id", async (req, res) => {
  const { titulo, descripcion, imagen_base64 } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE qr_generados
       SET titulo      = COALESCE($1::text, titulo),
           descripcion = COALESCE($2::text, descripcion),
           imagen_data = CASE WHEN $3::text IS NOT NULL AND $3::text != '' THEN $3::text ELSE imagen_data END
       WHERE id=$4 RETURNING *`,
      [titulo ?? null, descripcion ?? null, imagen_base64 ?? null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "QR no encontrado" });
    res.json({ ok: true, qr: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/api/qr/:id/png", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM qr_generados WHERE id=$1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "QR no encontrado" });
    const pngBuffer = await QRCode.toBuffer(rows[0].url, { width: 300, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="QR_${rows[0].pasillo}_${rows[0].nivel}.png"`);
    res.send(pngBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/qr/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM qr_generados WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PWA MÓVIL — Login
// =========================
app.post("/auth/login", async (req, res) => {
  const { correo, password } = req.body || {};
  if (!correo || !password) return res.status(400).json({ error: "Correo y contraseña requeridos" });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM usuarios WHERE LOWER(email)=LOWER($1) AND activo=true", [correo]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Usuario no encontrado" });
    const usuario = rows[0];
    if (!usuario.password_hash) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE usuarios SET password_hash=$1 WHERE id=$2", [hash, usuario.id]);
      const { password_hash, ...safe } = usuario;
      return res.json({ token: `token-${usuario.id}-${Date.now()}`, user: { ...safe, correo: safe.email, rol: (safe.rol || "vendedor").toLowerCase() } });
    }
    const match = await bcrypt.compare(password, usuario.password_hash);
    if (!match) return res.status(401).json({ error: "Contraseña incorrecta" });
    const { password_hash, ...safe } = usuario;
    res.json({ token: `token-${usuario.id}-${Date.now()}`, user: { ...safe, correo: safe.email, rol: (safe.rol || "vendedor").toLowerCase() } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PWA MÓVIL — Solicitudes vendedor
// =========================
app.get("/solicitudes/mias", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows } = await pool.query(
      `SELECT id, numero_qr AS numero, pasillo, fila, estado, created_at,
              TO_CHAR(created_at,'HH12:MI AM') AS hora
       FROM solicitudes
       WHERE estado IN ('pendiente','asignada','en_curso')
         AND vendedor_id = $1::integer
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date
       ORDER BY created_at DESC LIMIT 20`,
      [vendedorId]
    );
    console.log(`📋 /solicitudes/mias vendedor=${vendedorId} → ${rows.length} solicitudes`);
    res.json(rows.map(r => ({
      id:        String(r.id),
      numero:    r.numero,
      pasillo:   r.pasillo || r.fila || "General",
      hora:      r.hora,
      createdAt: r.created_at,
      estado:    r.estado === "en_curso"  ? "En curso"  :
                 r.estado === "pendiente" ? "Pendiente" :
                 r.estado === "asignada"  ? "Pendiente" : "Por vencer",
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/solicitudes/:id/estado", async (req, res) => {
  const { estado } = req.body || {};
  const nuevoEstado = normalizeEstado(estado);
  try {
    const { rows } = await pool.query(
      `UPDATE solicitudes
       SET estado        = $1::varchar,
           hora_atendida = CASE WHEN $1::varchar='resuelta' AND hora_atendida IS NULL THEN NOW() ELSE hora_atendida END,
           en_curso_at   = CASE WHEN $1::varchar='en_curso'  AND en_curso_at  IS NULL THEN NOW() ELSE en_curso_at  END,
           updated_at    = NOW()
       WHERE id=$2
       RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
         vendedor_id AS "vendedorId", rating, cancelacion_tipo AS "cancelacionTipo",
         hora_atendida AS "horaAtendida", en_curso_at AS "enCursoAt",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [nuevoEstado, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    const row = safeRow(rows[0]);
    io.emit("solicitud_estado", row);
    if (nuevoEstado === "resuelta" || nuevoEstado === "cancelada") redistribuirSaturados().catch(() => {});
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PWA MÓVIL — Admin/Supervisor
// =========================
app.get("/admin/solicitudes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, numero_qr AS numero, pasillo, fila, vendedor, estado,
              TO_CHAR(created_at,'HH12:MI AM') AS hora,
              created_at AS "createdAt"
       FROM solicitudes
       WHERE estado IN ('pendiente','asignada','en_curso')
       ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows.map(r => ({
      id:        String(r.id),
      numero:    r.numero,
      pasillo:   r.pasillo || r.fila || "General",
      vendedor:  r.vendedor || "Sin asignar",
      hora:      r.hora,
      createdAt: r.createdAt,
      estado:    r.estado === "en_curso"  ? "En curso"  :
                 r.estado === "pendiente" ? "Pendiente" :
                 r.estado === "asignada"  ? "Pendiente" : "Por vencer",
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/admin/vendedores", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id,
              u.nombre||' '||u.apellidos AS nombre,
              UPPER(LEFT(u.nombre,1)||LEFT(u.apellidos,1)) AS iniciales,
              u.estado,
              COUNT(s.id) FILTER (WHERE s.estado IN ('pendiente','asignada'))            AS pendientes,
              COUNT(s.id) FILTER (WHERE s.estado IN ('pendiente','asignada','en_curso')) AS asignadas
       FROM usuarios u
       LEFT JOIN solicitudes s ON s.vendedor_id=u.id
         AND s.estado IN ('pendiente','asignada','en_curso')
       WHERE u.rol='Vendedor' AND u.activo=true
       GROUP BY u.id, u.nombre, u.apellidos, u.estado`
    );
    res.json(rows.map(r => ({
      id:         r.id,
      nombre:     r.nombre,
      iniciales:  r.iniciales,
      asignadas:  Number(r.asignadas)  || 0,
      pendientes: Number(r.pendientes) || 0,
      enBreak:    r.estado === "Inactivo",
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/admin/control-carga", async (req, res) => {
  try {
    const { rows: vends } = await pool.query(
      `SELECT id, nombre||' '||apellidos AS nombre,
              UPPER(LEFT(nombre,1)||LEFT(apellidos,1)) AS iniciales,
              pasillos, estado
       FROM usuarios WHERE rol='Vendedor' AND activo=true`
    );
    const result = await Promise.all(vends.map(async v => {
      const { rows: sols } = await pool.query(
        `SELECT id, numero_qr AS numero, pasillo, fila, estado,
                TO_CHAR(created_at,'HH12:MI AM') AS hora,
                created_at AS "createdAt"
         FROM solicitudes
         WHERE vendedor_id=$1
           AND estado IN ('pendiente','asignada','en_curso')
           AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`,
        [v.id]
      );
      const enCurso = sols.filter(s => s.estado === "en_curso").length;
      const { rows: pvRows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND (NOW()-created_at) >= INTERVAL '3 minutes') AS por_vencer,
           COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND (NOW()-created_at) <  INTERVAL '3 minutes') AS pendientes
         FROM solicitudes
         WHERE vendedor_id=$1 AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`,
        [v.id]
      );
      const { rows: cancelRow } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM solicitudes
         WHERE vendedor_id=$1 AND estado='cancelada' AND DATE(updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`,
        [v.id]
      );
      return {
        id:        v.id,
        nombre:    v.nombre,
        iniciales: v.iniciales,
        pasillos:  Array.isArray(v.pasillos) ? v.pasillos.join(", ") : "General",
        enBreak:   v.estado === "Inactivo",
        porVencer: Number(pvRows[0]?.por_vencer || 0),
        asignadas: Number(pvRows[0]?.pendientes  || 0),
        enCurso,
        canceladas: Number(cancelRow[0]?.cnt || 0),
        solicitudes: sols.map(s => ({
          id:        String(s.id),
          numero:    s.numero,
          pasillo:   s.pasillo || s.fila || "General",
          hora:      s.hora,
          createdAt: s.createdAt,
          estado:    s.estado === "en_curso" ? "En curso" : "Pendiente",
        })),
      };
    }));
    res.json(result);
  } catch (err) { console.error('❌ /admin/control-carga:', err.message); res.status(500).json({ error: err.message }); }
});
app.put("/admin/solicitudes/:id/reasignar", async (req, res) => {
  const vendedorId = Number(req.body?.vendedorId);
  try {
    if (!vendedorId || isNaN(vendedorId)) return res.status(400).json({ error: "vendedorId inválido" });
    const { rows: vend } = await pool.query(
      `SELECT nombre||' '||apellidos AS nombre FROM usuarios WHERE id=$1`, [vendedorId]
    );
    if (vend.length === 0) return res.status(404).json({ error: "Vendedor no encontrado" });
    const { rows } = await pool.query(
      `UPDATE solicitudes SET vendedor_id=$1, vendedor=$2, estado='asignada', updated_at=NOW()
       WHERE id=$3
       RETURNING id, numero_qr AS "numeroQR", fila, pasillo, estado, vendedor,
         vendedor_id AS "vendedorId", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [vendedorId, vend[0].nombre, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    const emitData = safeRow(rows[0]);
    io.emit("solicitud_asignada", { ...emitData, vendedorId: Number(vendedorId), vendedor_id: Number(vendedorId) });
    // Notificar al vendedor. Contar TODAS sus solicitudes activas (sin filtro
    // de fecha): la recién reasignada debe contar aunque se haya creado otro
    // día o haya desfase de zona horaria — si no, el mensaje diría "0".
    const { rows: cargaReasig } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM solicitudes
       WHERE vendedor_id=$1 AND estado IN ('pendiente','asignada','en_curso')`,
      [vendedorId]
    );
    const totalReasig = Math.max(1, Number(cargaReasig[0]?.cnt || 1));
    console.log(`🔁 Reasignando solicitud ${emitData.id} a vendedor ${vendedorId}`);
    await sendPush(
      vendedorId,
      '🛒 Nueva solicitud asignada',
      `Pasillo ${emitData.pasillo || emitData.fila || 'General'} · N° ${emitData.numeroQR}. Tienes ${totalReasig} solicitud${totalReasig > 1 ? 'es' : ''} activa${totalReasig > 1 ? 's' : ''}.`,
      { tipo: 'nueva_solicitud', solicitudId: emitData.id }
    );
    res.json(emitData);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/admin/stats", async (req, res) => {
  try {
    const { rows: vends } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE activo=true AND rol='Vendedor')                       AS total_vendedores,
         COUNT(*) FILTER (WHERE activo=true AND rol='Vendedor' AND estado='Inactivo') AS en_break
       FROM usuarios`
    );
    const { rows: sols } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date)                                                                               AS total_hoy,
         COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date)                                        AS asignadas,
         COUNT(*) FILTER (WHERE estado='en_curso' AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date)                                                         AS en_curso,
         COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND (NOW()-created_at)>INTERVAL '3 minutes' AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date) AS por_vencer,
         ROUND(AVG(rating) FILTER (WHERE estado='resuelta' AND DATE(updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date AND rating IS NOT NULL), 1) AS promedio_rating
       FROM solicitudes`
    );
    res.json({
      vendedores: Number(vends[0]?.total_vendedores || 0),
      enBreak:    Number(vends[0]?.en_break         || 0),
      totalHoy:   Number(sols[0]?.total_hoy          || 0),
      asignadas:  Number(sols[0]?.asignadas           || 0),
      enCurso:    Number(sols[0]?.en_curso             || 0),
      porVencer:  Number(sols[0]?.por_vencer           || 0),
      rating:     sols[0]?.promedio_rating ? Number(sols[0].promedio_rating) : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PWA MÓVIL — Breaks vendedor
// =========================
app.get("/breaks/hoy", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows } = await pool.query(
      `SELECT id, inicio, fin, tipo FROM breaks
       WHERE vendedor_id=$1 AND inicio>=CURRENT_DATE ORDER BY inicio DESC`,
      [vendedorId]
    );
    const breakAbierto = rows.find(b => !b.fin) || null;
    res.json({
      breaks: rows.filter(b => b.fin).map(b => ({
        id:      b.id,
        hora:    new Date(b.inicio).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: "America/Santiago" }),
        minutos: Math.max(0, Math.round((new Date(b.fin) - new Date(b.inicio)) / 60000)),
      })),
      breakActivo:       !!breakAbierto,
      inicioBreakActual: breakAbierto ? breakAbierto.inicio : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/breaks/iniciar", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows: vend } = await pool.query(
      `SELECT nombre||' '||apellidos AS nombre FROM usuarios WHERE id=$1`, [vendedorId]
    );
    const { rows } = await pool.query(
      `INSERT INTO breaks (vendedor_id,vendedor_nombre,inicio,tipo)
       VALUES ($1,$2,NOW(),'break') RETURNING id, inicio`,
      [vendedorId, vend[0]?.nombre || ""]
    );
    await pool.query(`UPDATE usuarios SET estado='Inactivo' WHERE id=$1`, [vendedorId]);
    io.emit("vendedor_estado", { vendedorId: Number(vendedorId), estado: "Inactivo" });
    res.json({ ok: true, inicio: rows[0].inicio });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/breaks/finalizar", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows } = await pool.query(
      `UPDATE breaks SET fin=NOW() WHERE vendedor_id=$1 AND fin IS NULL RETURNING id, inicio, fin`,
      [vendedorId]
    );
    await pool.query(`UPDATE usuarios SET estado='Activo' WHERE id=$1`, [vendedorId]);
    io.emit("vendedor_estado", { vendedorId: Number(vendedorId), estado: "Activo" });
    const ultimo  = rows[0];
    const minutos = ultimo ? Math.max(0, Math.round((new Date(ultimo.fin) - new Date(ultimo.inicio)) / 60000)) : 0;
    const hora    = ultimo ? new Date(ultimo.inicio).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—";
    res.json({ ok: true, break: { hora, minutos } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/breaks/almuerzo", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows } = await pool.query(
      `SELECT inicio_almuerzo, fin_almuerzo FROM usuarios WHERE id=$1`, [vendedorId]
    );
    res.json({ inicio: rows[0]?.inicio_almuerzo || "13:00", fin: rows[0]?.fin_almuerzo || "14:00" });
  } catch { res.json({ inicio: "13:00", fin: "14:00" }); }
});
app.put("/breaks/almuerzo", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  const { inicio, fin } = req.body || {};
  try {
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS inicio_almuerzo VARCHAR(5) DEFAULT '13:00'`).catch(() => {});
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fin_almuerzo    VARCHAR(5) DEFAULT '14:00'`).catch(() => {});
    await pool.query(
      `UPDATE usuarios SET inicio_almuerzo=$1, fin_almuerzo=$2 WHERE id=$3`,
      [inicio, fin, vendedorId]
    );
    res.json({ ok: true, inicio, fin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PWA MÓVIL — Perfil vendedor
// =========================
app.get("/perfil/me", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, apellidos, email, rol, estado FROM usuarios WHERE id=$1`, [vendedorId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/perfil/stats", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    // TODOS los contadores son del DÍA en curso en Chile. En un nuevo día,
    // todo parte en 0 — las solicitudes de ayer no se cuentan en ninguna
    // categoría. Resueltas/canceladas filtran por updated_at (cuándo se
    // cerraron hoy); pendientes/en curso/por vencer filtran por created_at
    // (solicitudes creadas hoy que siguen activas).
    const HOY = `DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`;
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE estado='resuelta'  AND DATE(updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date) AS resueltas_hoy,
         COUNT(*) FILTER (WHERE estado='cancelada' AND DATE(updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date) AS canceladas_hoy,
         COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND (NOW()-created_at) < INTERVAL '3 minutes'  AND ${HOY}) AS pendientes,
         COUNT(*) FILTER (WHERE estado IN ('pendiente','asignada') AND (NOW()-created_at) >= INTERVAL '3 minutes' AND ${HOY}) AS por_vencer,
         COUNT(*) FILTER (WHERE estado='en_curso' AND ${HOY}) AS en_curso
       FROM solicitudes WHERE vendedor_id=$1`,
      [vendedorId]
    );
    const out = {
      resueltas:  Number(rows[0]?.resueltas_hoy  || 0),
      canceladas: Number(rows[0]?.canceladas_hoy || 0),
      pendientes: Number(rows[0]?.pendientes      || 0),
      porVencer:  Number(rows[0]?.por_vencer      || 0),
      enCurso:    Number(rows[0]?.en_curso         || 0),
    };
    console.log(`📊 /perfil/stats vendedor=${vendedorId} →`, JSON.stringify(out));
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/perfil/password", async (req, res) => {
  const vendedorId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  const { actual, nueva } = req.body || {};
  try {
    const { rows } = await pool.query(
      `SELECT password_hash FROM usuarios WHERE id=$1`, [vendedorId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    const match = await bcrypt.compare(actual, rows[0].password_hash || "");
    if (!match) return res.status(401).json({ error: "Contraseña actual incorrecta" });
    const hash = await bcrypt.hash(nueva, 10);
    await pool.query(`UPDATE usuarios SET password_hash=$1 WHERE id=$2`, [hash, vendedorId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// PUSH SUBSCRIPTIONS
// =========================
app.get("/push/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});
app.post("/push/subscribe", async (req, res) => {
  const { subscription, rol, usuarioId: usuarioIdBody, notificarAhora } = req.body || {};
  // Extraer del token; si falla (token ausente en ese instante), usar el
  // usuarioId que el cliente envía como respaldo en el body.
  const usuarioIdToken = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  const usuarioId = usuarioIdToken || (usuarioIdBody ? String(usuarioIdBody) : null);
  console.log(`📥 /push/subscribe usuario=${usuarioId} (token=${usuarioIdToken ?? 'null'} body=${usuarioIdBody ?? 'null'}) rol=${rol || 'vendedor'} endpoint=${subscription?.endpoint ? subscription.endpoint.slice(0,50)+'...' : 'NULO'}`);
  if (!subscription || !usuarioId) return res.status(400).json({ error: "Faltan datos" });
  try {
    // Este NAVEGADOR (identificado por su endpoint único) ahora pertenece al
    // usuario que acaba de iniciar sesión. Si el mismo endpoint estaba
    // registrado bajo OTRO usuario (p.ej. una sesión anterior en este mismo
    // dispositivo), eliminarlo — así las notificaciones de ese otro usuario
    // dejan de llegar a este navegador.
    const endpoint = subscription.endpoint;
    if (endpoint) {
      await pool.query(
        `DELETE FROM push_subscriptions
         WHERE subscription->>'endpoint' = $1 AND usuario_id <> $2`,
        [endpoint, usuarioId]
      );
    }
    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id,rol,subscription)
       VALUES ($1,$2,$3)
       ON CONFLICT (usuario_id) DO UPDATE SET subscription=$3, rol=$2`,
      [usuarioId, rol || 'vendedor', JSON.stringify(subscription)]
    );
    console.log(`✅ Suscripción push guardada para usuario ${usuarioId}`);
    res.json({ ok: true });
    // Tras suscribirse, verificar el rol REAL del usuario en la BD. Si es
    // Admin/Supervisor: (1) resetear el contador de notificación de admin para
    // que el próximo ciclo vuelva a evaluar y notifique aunque el número no
    // suba (cubre el caso de un admin que se suscribe DESPUÉS de que las
    // solicitudes ya estaban por vencer), y (2) enviarle de inmediato una
    // notificación con el estado actual si ya hay solicitudes por vencer, para
    // que no tenga que esperar al próximo cambio.
    try {
      const { rows: ur } = await pool.query(
        `SELECT rol FROM usuarios WHERE id=$1`, [usuarioId]
      );
      const rolReal = ur[0]?.rol;
      // Solo enviar la notificación inmediata cuando el admin ACTIVA/RENUEVA
      // manualmente (notificarAhora=true). Los re-registros automáticos del
      // socket NO la disparan — así se evita el spam de notificaciones
      // idénticas que Chrome bloquea.
      if ((rolReal === 'Admin' || rolReal === 'Supervisor') && notificarAhora) {
        // Forzar re-evaluación en el próximo ciclo
        _pushState.adminUltimo = 0;
        // Enviar estado actual de inmediato a ESTE admin si hay por vencer
        const { rows: pv } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM solicitudes
           WHERE estado IN ('pendiente','asignada')
             AND (NOW() - created_at) >= INTERVAL '3 minutes'
             AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
        );
        const totalPV = Number(pv[0]?.cnt || 0);
        if (totalPV > 0) {
          const payload = JSON.stringify({
            title: '🔴 Solicitudes por vencer',
            body:  `Hay ${totalPV} solicitud${totalPV > 1 ? 'es' : ''} por vencer. Revisa si es necesario reasignar.`,
            data:  { tipo: 'admin_por_vencer', cantidad: totalPV },
          });
          try {
            await webpush.sendNotification(subscription, payload);
            console.log(`📤 Notificación inmediata enviada al admin ${usuarioId} (${totalPV} por vencer)`);
          } catch (e) {
            console.log(`❌ Notif inmediata admin ${usuarioId}: ${e.statusCode || e.message}`);
          }
        }
      }
    } catch (e) { console.log('Post-subscribe admin check error:', e.message); }
  } catch (err) {
    console.log(`❌ Error guardando suscripción usuario ${usuarioId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
// Verificar si la suscripción del usuario sigue en la BD
// DIAGNÓSTICO: ver TODAS las suscripciones guardadas y su antigüedad
app.get("/push/status", async (req, res) => {
  const usuarioIdToken = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  const usuarioId = usuarioIdToken;
  if (!usuarioId) return res.json({ active: false });
  try {
    const { rows } = await pool.query(
      `SELECT subscription->>'endpoint' AS endpoint FROM push_subscriptions WHERE usuario_id=$1`,
      [usuarioId]
    );
    res.json({ active: rows.length > 0, endpoint: rows[0]?.endpoint || null });
  } catch { res.json({ active: false }); }
});
app.delete("/push/unsubscribe", async (req, res) => {
  const usuarioId = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  try {
    await pool.query(`DELETE FROM push_subscriptions WHERE usuario_id=$1`, [usuarioId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Re-suscripción automática desde el Service Worker (evento
// pushsubscriptionchange). El navegador rotó la suscripción: identificamos al
// usuario por su endpoint ANTERIOR y actualizamos su fila con la nueva
// suscripción. No requiere token (el SW no tiene acceso al login). Esto evita
// que las suscripciones queden muertas (410) cuando Chrome/FCM las rota.
app.post("/push/resubscribe", async (req, res) => {
  const { oldEndpoint, subscription } = req.body || {};
  if (!subscription) return res.status(400).json({ error: "Falta subscription" });
  try {
    let usuarioId = null;
    if (oldEndpoint) {
      const { rows } = await pool.query(
        `SELECT usuario_id FROM push_subscriptions WHERE subscription->>'endpoint' = $1`,
        [oldEndpoint]
      );
      usuarioId = rows[0]?.usuario_id || null;
    }
    if (!usuarioId) {
      console.log(`🔄 /push/resubscribe: no se encontró usuario por endpoint viejo`);
      return res.json({ ok: false, motivo: 'usuario_no_encontrado' });
    }
    // Actualizar la suscripción del usuario (UNIQUE usuario_id → reemplaza)
    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id, rol, subscription)
       VALUES ($1, (SELECT rol FROM push_subscriptions WHERE usuario_id=$1 LIMIT 1), $2)
       ON CONFLICT (usuario_id) DO UPDATE SET subscription=$2`,
      [usuarioId, JSON.stringify(subscription)]
    );
    limpiar410(usuarioId);
    console.log(`🔄 /push/resubscribe: suscripción actualizada para usuario ${usuarioId} (rotación de FCM)`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ /push/resubscribe:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
// Endpoint de PRUEBA: envía una notificación inmediata al usuario actual.
// Sirve para aislar si el problema es la ENTREGA al dispositivo (si esta llega,
// el push funciona; si no llega pero el log dice enviado, es el dispositivo/SW).
app.post("/push/test", async (req, res) => {
  const usuarioIdToken = req.headers["authorization"]?.replace("Bearer ", "").split("-")[1] || null;
  const usuarioId = usuarioIdToken || (req.body?.usuarioId ? String(req.body.usuarioId) : null);
  if (!usuarioId) return res.status(400).json({ error: "Sin usuario" });
  try {
    const { rows } = await pool.query(
      `SELECT subscription FROM push_subscriptions WHERE usuario_id=$1`, [usuarioId]
    );
    if (rows.length === 0) {
      console.log(`🧪 /push/test usuario ${usuarioId}: SIN suscripción en BD`);
      return res.json({ ok: false, motivo: 'sin_suscripcion' });
    }
    const payload = JSON.stringify({
      title: '🔔 Notificación de prueba',
      body:  'Si ves esto, las notificaciones funcionan correctamente.',
      data:  { tipo: 'prueba' },
    });
    try {
      await webpush.sendNotification(rows[0].subscription, payload);
      console.log(`🧪 /push/test usuario ${usuarioId}: ✅ ENVIADO (endpoint=${rows[0].subscription?.endpoint?.slice(0,45)}...)`);
      limpiar410(usuarioId);
      res.json({ ok: true });
    } catch (e) {
      console.log(`🧪 /push/test usuario ${usuarioId}: ❌ ERROR ${e.statusCode} ${e.body || e.message}`);
      if (e.statusCode === 410 || e.statusCode === 404) await registrar410(usuarioId, rows[0].subscription?.endpoint);
      res.json({ ok: false, motivo: 'error_envio', status: e.statusCode });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// =========================
// ARRANQUE
// =========================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Backend escuchando en puerto ${PORT}`));
// Al arrancar: cerrar de inmediato solicitudes activas de días anteriores
// (en zona horaria Chile), por si el servidor estuvo caído al cambiar el día.
(async () => {
  try {
    // Igual que la limpieza diaria: estado 'expirada' (no cuenta como
    // cancelada) y sin tocar updated_at.
    const { rowCount } = await pool.query(
      `UPDATE solicitudes SET estado='expirada'
       WHERE estado IN ('pendiente','asignada','en_curso')
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
    );
    if (rowCount > 0) console.log(`🧹 Arranque: ${rowCount} solicitudes del día anterior expiradas`);
  } catch (err) { console.error('❌ Error limpieza al arranque:', err.message); }
  // Reprogramar los chequeos de "por vencer" para solicitudes activas de hoy
  // que AÚN no cumplen 3 minutos (por si el servidor se reinició). Así la
  // notificación sigue siendo inmediata aunque haya habido un redeploy.
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at FROM solicitudes
       WHERE estado IN ('pendiente','asignada')
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
    );
    let programadas = 0;
    for (const r of rows) {
      // El id es el timestamp de creación (Date.now()). Si por alguna razón no
      // fuera numérico, usar created_at.
      const createdMs = Number(r.id) || new Date(r.created_at).getTime();
      const objetivo  = createdMs + MS_POR_VENCER;
      if (objetivo > Date.now()) { programarChequeoPorVencer(createdMs); programadas++; }
    }
    if (programadas > 0) console.log(`⏱️ Arranque: ${programadas} chequeos de por-vencer reprogramados`);
    // Un chequeo inmediato cubre las que ya cruzaron el umbral mientras estaba caído
    chequearPorVencer().catch(() => {});
  } catch (err) { console.error('❌ Error reprogramando chequeos:', err.message); }
})();
