// ════════════════════════════════════════════════════════════
//  ASISTIVA LITE — Backend
//  Flujo: cliente escanea QR → /atencion/ crea la solicitud →
//  llega en tiempo real al panel (socket.io) → el panel la asigna.
//  Además: generación de QR, usuarios y login.
// ════════════════════════════════════════════════════════════
const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const path       = require("path");
const { Server } = require("socket.io");
const { Pool }   = require("pg");
const bcrypt     = require("bcrypt");
const QRCode     = require("qrcode");
const { Resend } = require("resend");

const app    = express();
const server = http.createServer(app);
app.set("trust proxy", true);

// =========================
// BASE DE DATOS
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});
// Forzar la zona horaria de CADA conexión a UTC. Sin esto, si la sesión de
// PostgreSQL viene configurada en otra zona, las conversiones
// `created_at AT TIME ZONE 'America/Santiago'` se duplican y rompen los
// filtros "de hoy".
pool.on("connect", (client) => {
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

// Tablas secundarias (las base — usuarios y solicitudes —
// se crean con crear_tablas_base.sql)
pool.connect()
  .then(async (client) => {
    client.release();
    console.log("✅ Conectado a PostgreSQL");
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
    `).then(() => console.log("✅ Columnas QR OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`ALTER TABLE qr_generados DROP CONSTRAINT IF EXISTS qr_generados_pasillo_nivel_key`).catch(() => {});
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT`)
      .then(() => console.log("✅ password_hash OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE`)
      .then(() => console.log("✅ must_change_password OK")).catch(() => {});
    // Pasillo y Área se escriben a mano: sin límite corto de largo.
    // (El área se guarda en la columna "nivel" para no cambiar la estructura.)
    await pool.query(`ALTER TABLE qr_generados ALTER COLUMN pasillo TYPE TEXT, ALTER COLUMN nivel TYPE TEXT`)
      .then(() => console.log("✅ qr_generados pasillo/área TEXT OK")).catch(e => console.error("⚠️", e.message));
    await pool.query(`ALTER TABLE solicitudes ALTER COLUMN pasillo TYPE TEXT, ALTER COLUMN nivel TYPE TEXT, ALTER COLUMN fila TYPE TEXT`)
      .then(() => console.log("✅ solicitudes pasillo/área TEXT OK")).catch(e => console.error("⚠️", e.message));
  })
  .catch(err => console.error("❌ Error conectando a PostgreSQL:", err.message));

// =========================
// EMAIL (recuperar contraseña)
// =========================
// Sin RESEND_API_KEY la app arranca igual y los emails solo se omiten.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
async function enviarEmail(to, subject, html) {
  if (!resend) {
    console.log(`✉️ Email omitido (sin RESEND_API_KEY) para ${to}`);
    return;
  }
  try {
    await resend.emails.send({ from: "Asistiva Sodimac <onboarding@resend.dev>", to, subject, html });
    console.log(`✅ Email enviado a ${to}`);
  } catch (err) {
    console.error("❌ Error enviando email:", err.message);
  }
}

// =========================
// CORS + MIDDLEWARE
// =========================
const allowedOrigins = [
  "https://asistiva-lite.cl",
  "https://www.asistiva-lite.cl",
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
// 5 MB: las imágenes de marca de los QR viajan en base64 dentro del JSON
app.use(express.json({ limit: "5mb" }));
// Evitar que el navegador/CDN cachee respuestas de la API
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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

// Número de ticket (A-001, A-002…). Se basa en el MAYOR número de toda la
// tabla, porque numero_qr es UNIQUE en toda la tabla.
let contadorTickets = 0;
async function sincronizarContador() {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SPLIT_PART(numero_qr,'-',2) AS INTEGER)),0) AS maxnum
     FROM solicitudes WHERE numero_qr LIKE 'A-%'`
  );
  const maxReal = parseInt(rows[0]?.maxnum || 0);
  if (maxReal >= contadorTickets) contadorTickets = maxReal;
}
sincronizarContador()
  .then(() => console.log(`🔢 Contador de tickets inicializado en ${contadorTickets}`))
  .catch(err => console.error("⚠️ No se pudo sincronizar contador:", err.message));

io.on("connection", socket => {
  console.log("✅ Cliente Socket conectado:", socket.id);
  socket.on("disconnect", () => console.log("🔌 Cliente Socket desconectado:", socket.id));
});

// Limpieza diaria: las solicitudes activas de días anteriores (hora Chile)
// pasan a 'expirada'. No cuentan como canceladas y no se toca updated_at.
async function expirarSolicitudesViejas(origen) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE solicitudes SET estado='expirada'
       WHERE estado IN ('pendiente','asignada','en_curso')
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago') < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`
    );
    if (rowCount > 0) {
      console.log(`🧹 ${origen}: ${rowCount} solicitudes del día anterior expiradas`);
      io.emit("solicitud_estado", { tipo: "limpieza_diaria" });
    }
  } catch (err) {
    console.error(`❌ Error limpieza (${origen}):`, err.message);
  }
}
setInterval(() => expirarSolicitudesViejas("Limpieza diaria"), 60 * 60 * 1000);

// =========================
// HEALTH
// =========================
app.get("/health", (req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, db: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =========================
// SOLICITUDES — panel (Dashboard y Reportes)
// =========================
const CAMPOS_SOLICITUD = `id, numero_qr AS "numeroQR", fila, pasillo, nivel, qr_id AS "qrId",
  estado, cancelacion_tipo AS "cancelacionTipo", hora_atendida AS "horaAtendida",
  created_at AS "createdAt", updated_at AS "updatedAt", en_curso_at AS "enCursoAt"`;

app.get("/solicitudes", async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    let query, params;
    if (desde && hasta) {
      query  = `SELECT ${CAMPOS_SOLICITUD} FROM solicitudes
                WHERE created_at >= $1 AND created_at <= $2
                ORDER BY created_at DESC LIMIT 2000`;
      params = [desde, hasta];
    } else if (desde) {
      query  = `SELECT ${CAMPOS_SOLICITUD} FROM solicitudes
                WHERE created_at >= $1
                ORDER BY created_at DESC LIMIT 2000`;
      params = [desde];
    } else {
      query  = `SELECT ${CAMPOS_SOLICITUD} FROM solicitudes ORDER BY created_at DESC LIMIT 200`;
      params = [];
    }
    const result = await pool.query(query, params);
    res.json(result.rows.map(safeRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Botón "Asignar" del panel: solo cambia el estado a 'asignada'
app.post("/solicitudes/:id/asignar", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE solicitudes SET estado=$1, updated_at=NOW()
       WHERE id=$2
       RETURNING id, numero_qr AS "numeroQR", fila, pasillo, nivel, estado,
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [ESTADOS.ASIGNADA, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    const sol = safeRow(result.rows[0]);
    io.emit("solicitud_asignada", sol);
    res.json(sol);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =========================
// ATENCIÓN — página del cliente (/atencion/ tras escanear el QR)
// =========================
app.post("/api/atencion", async (req, res) => {
  const { punto, p, n, a, q } = req.body || {};
  const pasillo = p ? String(p).slice(0, 60) : null;
  // QR nuevos traen el área (?a=); los QR antiguos traen el nivel (?n=1)
  const nivel   = a ? String(a).slice(0, 80) : (n ? `N${n}` : null);
  const qr_id   = q || null;
  const fila    = pasillo || punto || "General";
  const id      = Date.now();
  let numero;
  try {
    // Insertar reintentando si el número ya existe; al primer choque se
    // resincroniza el contador con el máximo real de la tabla.
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
          if (intento === 0) await sincronizarContador().catch(() => {});
          continue;
        }
        throw eIns;
      }
    }
    if (!insertado) throw new Error("No se pudo generar un número de atención único");

    const nuevaSolicitud = {
      id: String(id), numeroQR: numero, fila, pasillo, nivel, qr_id,
      createdAt: new Date().toISOString(), estado: ESTADOS.PENDIENTE,
    };
    io.emit("solicitud_nueva", nuevaSolicitud); // → aparece en el panel
    return res.json({ id: String(id), numero, createdAt: nuevaSolicitud.createdAt, estado: ESTADOS.PENDIENTE });
  } catch (err) {
    console.error("❌ Error creando solicitud:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/atencion/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, numero_qr AS numero, estado, created_at AS "createdAt", updated_at AS "updatedAt", fila AS punto
       FROM solicitudes WHERE id=$1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Solicitud no encontrada" });
    res.json(safeRow(result.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// El cliente cancela su solicitud desde /atencion/
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos`,
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
       WHERE id=$10
       RETURNING id, nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos`,
      [nombre, apellidos, rut, email, telefono, rol, activo, estado, pasillos, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/usuarios/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM usuarios WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
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
    // Primer login del admin inicial: sin password_hash, se guarda lo que escriba
    if (!usuario.password_hash) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE usuarios SET password_hash=$1 WHERE id=$2", [hash, usuario.id]);
      const { password_hash: _ph, ...safe } = usuario;
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
// QR
// =========================
app.get("/api/qr", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM qr_generados ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/qr/generar", async (req, res) => {
  const { titulo = "", descripcion = "", imagen_url = "", imagen_base64 = "" } = req.body || {};
  const pasillo = String(req.body?.pasillo || "").trim();
  const area    = String(req.body?.area ?? req.body?.nivel ?? "").trim();   // el área se guarda en "nivel"
  if (!pasillo || !area) return res.status(400).json({ error: "Pasillo y área requeridos" });
  try {
    // 1) Crear el registro para obtener su id
    const { rows: ins } = await pool.query(
      `INSERT INTO qr_generados (pasillo,nivel,url,titulo,descripcion,imagen_url,imagen_data,created_at)
       VALUES ($1,$2,'',$3,$4,$5,$6,NOW()) RETURNING id`,
      [pasillo, area, titulo, descripcion, imagen_url || "", imagen_base64 || ""]
    );
    const id = ins[0].id;
    // 2) URL del QR: pasillo + área + id del QR (para saber exactamente qué QR se escaneó)
    const url = `https://asistiva-lite.cl/atencion/?p=${encodeURIComponent(pasillo)}&a=${encodeURIComponent(area)}&q=${id}`;
    const { rows } = await pool.query(`UPDATE qr_generados SET url=$1 WHERE id=$2 RETURNING *`, [url, id]);
    const pngBase64 = await QRCode.toDataURL(url, { width: 300, margin: 2 });
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
// ARRANQUE
// =========================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Backend escuchando en puerto ${PORT}`));
// Por si el servidor estuvo caído al cambiar el día
expirarSolicitudesViejas("Arranque");
