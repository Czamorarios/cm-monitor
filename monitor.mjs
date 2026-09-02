#!/usr/bin/env node
/**
 * cm-monitor — Monitoreo de la plataforma CMillonario (cmillonario.com)
 *
 * Un solo programa, sin dependencias externas. Se ejecuta, revisa, avisa y termina.
 *
 *   node monitor.mjs                 corrida completa (capas 1, 2 y 3)
 *   node monitor.mjs --capa 1        solo disponibilidad (rapido, ~2s)
 *   node monitor.mjs --capa 1,2      disponibilidad + backend
 *   node monitor.mjs --dry-run       revisa pero NO manda alertas
 *   node monitor.mjs --reporte       resumen de las ultimas 24 h desde el historial
 *   node monitor.mjs --json          salida en JSON (para automatizar)
 *
 * REGLAS DE SEGURIDAD (no romper):
 *  - Todo es SOLO LECTURA. No escribe en ninguna base de datos.
 *  - A cualquier endpoint se le hace unicamente GET SIN CUERPO, que no puede
 *    provocar ninguna operacion: solo comprueba que el proceso este vivo.
 *  - Ningun secreto vive en este archivo. Todo va en .env (ignorado por git) o
 *    en los secretos del repositorio.
 *  - No lee ni guarda datos personales: solo cuenta documentos y mide tiempos.
 *  - Que se revisa lo decide la CONFIGURACION, no el codigo. Este archivo es
 *    generico a proposito para poder vivir en un repositorio publico: el perfil
 *    publico (checks.config.json) solo cubre lo que cualquier visitante del sitio
 *    ya puede observar, y el perfil privado (checks.private.json, nunca subido)
 *    agrega lo demas. Al editar, no metas aqui nombres ni detalles que no deban
 *    ser publicos: van en la configuracion privada.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import dnsp from 'node:dns/promises';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const DIR_ESTADO = join(RAIZ, 'state');
const DIR_REPORTES = join(RAIZ, 'reports');
const F_STATUS = join(DIR_ESTADO, 'status.json');
const F_HISTORIAL = join(DIR_ESTADO, 'history.jsonl');
const F_INCIDENTES = join(DIR_ESTADO, 'incidents.jsonl');

for (const d of [DIR_ESTADO, DIR_REPORTES]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// ─────────────────────────── utilidades ───────────────────────────

const C = process.env.NO_COLOR ? new Proxy({}, { get: () => (s) => s } ) : {
  rojo:  (s) => `\x1b[31m${s}\x1b[0m`,
  verde: (s) => `\x1b[32m${s}\x1b[0m`,
  ama:   (s) => `\x1b[33m${s}\x1b[0m`,
  azul:  (s) => `\x1b[36m${s}\x1b[0m`,
  gris:  (s) => `\x1b[90m${s}\x1b[0m`,
  fuerte:(s) => `\x1b[1m${s}\x1b[0m`,
};

const ICONO = { critico: '✖', aviso: '⚠', info: 'ℹ' };
const PINTA = { critico: C.rojo, aviso: C.ama, info: C.azul };

function cargarEnv() {
  const f = join(RAIZ, '.env');
  if (!existsSync(f)) return;
  for (const linea of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function leerJson(f, porDefecto) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return porDefecto; }
}

/**
 * Carga la configuracion en dos perfiles:
 *
 *   checks.config.json    PUBLICO. Vive en el repo publico. Solo revisa cosas que
 *                         cualquier visitante del sitio ya puede ver.
 *   checks.private.json   PRIVADO. NO se sube. Agrega las revisiones sensibles
 *                         (funciones de dinero, reglas de Firestore). Se busca
 *                         junto al programa y en ../cm-monitor-privado/.
 *
 * El privado se SUMA al publico: los arreglos se concatenan y los objetos se
 * mezclan. Asi el mismo monitor.mjs sirve para los dos casos sin ramas de codigo.
 */
function cargarConfig({ soloPublico = false } = {}) {
  const base = leerJson(join(RAIZ, 'checks.config.json'), null);
  if (!base) return null;
  base._perfil = 'publico';
  if (soloPublico) return base;

  const candidatos = [
    process.env.CM_MONITOR_PRIVADO,
    join(RAIZ, 'checks.private.json'),
    join(RAIZ, '..', 'cm-monitor-privado', 'checks.private.json'),
  ].filter(Boolean);

  const ruta = candidatos.find((f) => existsSync(f));
  if (!ruta) return base;

  const priv = leerJson(ruta, null);
  if (!priv) return base;
  base._perfil = 'publico+privado';
  base._rutaPrivada = ruta;
  return mezclar(base, priv);
}

function mezclar(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) a[k] = [...(Array.isArray(a[k]) ? a[k] : []), ...v];
    else if (v && typeof v === 'object') a[k] = mezclar(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    else a[k] = v;
  }
  return a;
}

/**
 * El repo publico no guarda el projectId ni la API key: se leen en vivo del propio
 * sitio, de /__/firebase/init.json, que es publico por diseno (el navegador de
 * cualquier visitante lo descarga). Asi el repo no contiene ningun identificador
 * de la plataforma, y ademas el monitor sigue funcionando si la key se rota.
 */
async function asegurarFirebase(cfg) {
  cfg.firebase ??= {};
  if (cfg.firebase.apiKeyPublica && cfg.firebase.projectId) return true;
  const r = await pedir(`${cfg.sitio.principal}/__/firebase/init.json`, { timeoutMs: 15000, leerCuerpo: true });
  if (!r.ok || r.code !== 200) return false;
  try {
    const j = JSON.parse(r.texto);
    cfg.firebase.apiKeyPublica ||= j.apiKey;
    cfg.firebase.projectId ||= j.projectId;
    return Boolean(cfg.firebase.apiKeyPublica && cfg.firebase.projectId);
  } catch { return false; }
}

/** Hora actual en la zona configurada, como {hhmm, minutos, dia, iso} */
function ahoraEn(tz) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const h = Number(p.hour) % 24, m = Number(p.minute);
  return {
    hhmm: `${String(h).padStart(2, '0')}:${m.toString().padStart(2, '0')}`,
    minutos: h * 60 + m,
    dia: p.weekday,
    fecha: `${p.year}-${p.month}-${p.day}`,
  };
}

function enVentana(ventana, tz) {
  const [hd, md] = ventana.desde.split(':').map(Number);
  const [hh, mh] = ventana.hasta.split(':').map(Number);
  const ini = hd * 60 + md, fin = hh * 60 + mh;
  const ahora = ahoraEn(tz).minutos;
  return ini <= fin ? (ahora >= ini && ahora < fin) : (ahora >= ini || ahora < fin);
}

const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, 'miércoles': 3, jueves: 4, viernes: 5, sabado: 6, 'sábado': 6 };

/** Minutos de desfase de la zona tz respecto a UTC en un instante dado (respeta horario de verano). */
function offsetMinutos(tz, ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const comoUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return (comoUTC - Math.floor(ms / 1000) * 1000) / 60000;
}

function partesEn(tz, ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { anio: +p.year, mes: +p.month, dia: +p.day, nDia: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] };
}

/** Primer instante posterior a desdeMs que cae en ese dia de la semana y hora, en la zona tz. */
function proximoDiaHora(desdeMs, nombreDia, hhmm, tz) {
  const objetivo = DIAS[String(nombreDia).toLowerCase()];
  if (objetivo === undefined) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const ms = desdeMs + i * 86400000;
    const p = partesEn(tz, ms);
    if (p.nDia !== objetivo) continue;
    const inst = Date.UTC(p.anio, p.mes - 1, p.dia, h, m) - offsetMinutos(tz, ms) * 60000;
    if (inst > desdeMs) return inst;
  }
  return null;
}

/**
 * Interpreta una fecha que puede venir en ISO o en el formato de texto que usa el
 * catalogo: "September 2, 2026 at 09:01:00 PM UTC" (con o sin desfase, "UTC-5").
 */
function fechaFlexible(v) {
  if (v == null) return NaN;
  const directo = Date.parse(v);
  if (!Number.isNaN(directo)) return directo;
  const m = String(v).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:UTC\s*([+-]\d{1,2})?)?$/i);
  if (!m) return NaN;
  const meses = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const mes = meses[m[1].toLowerCase()];
  if (mes === undefined) return NaN;
  let h = Number(m[4]);
  if (m[7]) { h %= 12; if (/pm/i.test(m[7])) h += 12; }
  return Date.UTC(+m[3], mes, +m[2], h, +m[5], +(m[6] || 0)) - (m[8] ? Number(m[8]) : 0) * 3600000;
}

/** Peticion HTTP medida. Nunca lanza: los errores vienen en el resultado. */
async function pedir(url, opciones = {}) {
  const { metodo = 'GET', timeoutMs = 20000, leerCuerpo = false, maxBytes = 300000, cuerpo = null, headers = {} } = opciones;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: metodo, signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'cm-monitor/1.0 (+monitoreo interno CMillonario)', ...headers },
      body: cuerpo,
    });
    let texto = null;
    if (leerCuerpo) {
      const buf = await r.arrayBuffer();
      texto = Buffer.from(buf.slice(0, maxBytes)).toString('utf8');
    } else {
      try { await r.arrayBuffer(); } catch { /* ignorar */ }
    }
    return { ok: true, code: r.status, ct: r.headers.get('content-type') || '', headers: r.headers, texto, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, code: 0, ct: '', headers: null, texto: null, ms: Date.now() - t0, error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(e.message || e) };
  } finally { clearTimeout(t); }
}

function certificado(host) {
  return new Promise((res, rej) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 12000 }, () => {
      const c = s.getPeerCertificate(); s.end(); res(c);
    });
    s.on('error', rej);
    s.on('timeout', () => { s.destroy(); rej(new Error('timeout TLS')); });
  });
}

// ─────────────────────────── Firestore (solo lectura, API REST) ───────────────────────────

const fsUrl = (cfg, ruta) =>
  `https://firestore.googleapis.com/v1/projects/${cfg.firebase.projectId}/databases/(default)/documents${ruta}`;

async function fsListar(cfg, col, pageSize = 1) {
  return pedir(`${fsUrl(cfg, '/' + col)}?key=${cfg.firebase.apiKeyPublica}&pageSize=${pageSize}`,
    { timeoutMs: cfg.umbrales.timeoutMs, leerCuerpo: true });
}

async function fsConsulta(cfg, col, campoOrden, limite) {
  const cuerpo = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: col }],
      orderBy: [{ field: { fieldPath: campoOrden }, direction: 'DESCENDING' }],
      limit: limite,
    },
  });
  return pedir(`${fsUrl(cfg, ':runQuery')}?key=${cfg.firebase.apiKeyPublica}`,
    { metodo: 'POST', cuerpo, headers: { 'Content-Type': 'application/json' }, timeoutMs: cfg.umbrales.timeoutMs, leerCuerpo: true, maxBytes: 900000 });
}

/** Convierte un documento REST de Firestore a objeto plano (solo tipos simples). */
function plano(doc) {
  const o = { _id: (doc.name || '').split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    const t = Object.keys(v)[0];
    o[k] = t === 'arrayValue' ? (v.arrayValue.values || []).length
         : t === 'mapValue' ? '{map}'
         : v[t];
  }
  return o;
}

// ─────────────────────────── sesion de solo lectura ───────────────────────────

/**
 * Algunos datos de juego (que sorteo esta abierto y hasta cuando se vende) no son
 * legibles sin sesion: la funcion de catalogo exige un token de Firebase y el
 * proyecto tiene deshabilitada la sesion anonima. Para eso se usa una CUENTA DE
 * PRUEBA dedicada, con saldo cero y sin metodo de pago.
 *
 * Las credenciales SOLO llegan por variables de entorno (.env en local, secretos
 * del repositorio en la nube). Nunca se escriben en disco, nunca se imprimen, y
 * nunca viajan al repositorio publico: las revisiones que las usan viven en el
 * perfil privado. Si no hay credenciales, esas revisiones sencillamente no existen.
 */
let _sesion = null;

async function sesionDePrueba(cfg) {
  if (_sesion && _sesion.idToken && _sesion.expira > Date.now() + 60000) return _sesion;

  const correo = (process.env.CM_USUARIO_PRUEBA || '').trim();
  const clave = process.env.CM_PASSWORD_PRUEBA || '';
  if (!correo || !clave) return null;

  if (!await asegurarFirebase(cfg)) return { error: 'no se pudo obtener la configuracion de Firebase del sitio' };

  const r = await pedir(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${cfg.firebase.apiKeyPublica}`, {
    metodo: 'POST', headers: { 'Content-Type': 'application/json' },
    timeoutMs: cfg.umbrales.timeoutMs, leerCuerpo: true,
    cuerpo: JSON.stringify({ email: correo, password: clave, returnSecureToken: true }),
  });

  if (!r.ok || r.code !== 200) {
    let motivo = r.error || `HTTP ${r.code}`;
    try { motivo = JSON.parse(r.texto).error?.message || motivo; } catch { /* ignorar */ }
    _sesion = { error: motivo };          // nunca se guarda la clave ni el token
    return _sesion;
  }
  try {
    const j = JSON.parse(r.texto);
    _sesion = { idToken: j.idToken, expira: Date.now() + (Number(j.expiresIn || 3600) - 60) * 1000 };
    return _sesion;
  } catch { return (_sesion = { error: 'respuesta de sesion no interpretable' }); }
}

/**
 * Llama una funcion del backend con la sesion de prueba.
 * Estas rutas son GET y llevan los parametros en la URL (con POST responden 405).
 */
async function llamarConSesion(cfg, funcion, params = null, metodo = 'GET') {
  const s = await sesionDePrueba(cfg);
  if (!s) return { code: 0, error: 'sin credenciales de la cuenta de prueba' };
  if (s.error) return { code: 0, error: `no se pudo iniciar sesion: ${s.error}` };

  let url = cfg.funciones.plantillaGen2.replace('{f}', funcion);
  const cuerpo = metodo === 'GET' ? null : JSON.stringify(params || {});
  if (metodo === 'GET' && params && Object.keys(params).length) {
    url += '?' + new URLSearchParams(params).toString();
  }

  const r = await pedir(url, {
    metodo, timeoutMs: cfg.umbrales.timeoutMs, leerCuerpo: true, maxBytes: 300000,
    headers: { Authorization: `Bearer ${s.idToken}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    cuerpo,
  });
  if (!r.ok) return { code: 0, error: r.error, ms: r.ms };
  let datos = null;
  try { datos = JSON.parse(r.texto); } catch { /* puede no ser JSON */ }
  return { code: r.code, datos, texto: r.texto, ms: r.ms };
}

// ─────────────────────────── definicion de revisiones ───────────────────────────

/**
 * Cada revision devuelve { ok, detalle, ms?, sev? }.
 * ctx guarda cosas compartidas (el HTML del home) para no pedirlo dos veces.
 */
function construirRevisiones(cfg) {
  const U = cfg.umbrales;
  const R = [];
  const add = (o) => R.push(o);

  // ═══════════ CAPA 1 — DISPONIBILIDAD ═══════════

  add({
    id: 'home', capa: 1, sev: 'critico', secuencial: true, nombre: 'Home responde y trae contenido real',
    async run(ctx) {
      const r = await pedir(cfg.sitio.principal, { timeoutMs: U.timeoutMs, leerCuerpo: true });
      ctx.home = r;
      if (!r.ok) return { ok: false, detalle: `sin respuesta: ${r.error}`, ms: r.ms };
      if (r.code !== 200) return { ok: false, detalle: `HTTP ${r.code}`, ms: r.ms };
      if (!r.texto || !r.texto.includes(cfg.sitio.marcadorHtml))
        return { ok: false, detalle: `HTTP 200 pero el HTML NO contiene el marcador "${cfg.sitio.marcadorHtml}" (posible pagina de error o deploy roto)`, ms: r.ms };
      return { ok: true, detalle: `HTTP 200, ${r.texto.length} bytes, marcador presente`, ms: r.ms };
    },
  });

  add({
    id: 'home_latencia', capa: 1, sev: 'aviso', nombre: `Latencia del home < ${U.ttfbHomeMs} ms`,
    async run(ctx) {
      const r = ctx.home;
      if (!r || !r.ok) return { ok: false, detalle: 'no se pudo medir (el home no respondio)' };
      return { ok: r.ms <= U.ttfbHomeMs, detalle: `${r.ms} ms`, ms: r.ms };
    },
  });

  // Esta es la revision que atrapa la pantalla blanca por deploy roto.
  for (const [clave, patron, ext] of [['js', /src="(main\.[a-z0-9]+\.js)"/i, 'JS'], ['css', /href="(styles\.[a-z0-9]+\.css)"/i, 'CSS']]) {
    add({
      id: `bundle_${clave}`, capa: 1, sev: 'critico', nombre: `El bundle ${ext} que pide el HTML existe`,
      async run(ctx) {
        if (!ctx.home?.texto) return { ok: false, detalle: 'no se pudo leer el HTML del home' };
        const m = ctx.home.texto.match(patron);
        if (!m) return { ok: false, detalle: `el HTML ya no referencia un archivo ${ext} con el patron esperado (cambio la forma del build?)` };
        const url = new URL(m[1], cfg.sitio.principal).href;
        const r = await pedir(url, { timeoutMs: U.timeoutMs });
        if (!r.ok) return { ok: false, detalle: `${m[1]}: ${r.error}`, ms: r.ms };
        if (r.code !== 200) return { ok: false, detalle: `${m[1]} devuelve HTTP ${r.code} -> PANTALLA BLANCA: el HTML pide un archivo que no existe`, ms: r.ms };
        return { ok: true, detalle: `${m[1]} OK`, ms: r.ms };
      },
    });
  }

  for (const d of cfg.sitio.dominios) {
    if (d.url === cfg.sitio.principal) continue;
    add({
      id: `dominio_${d.url.replace(/https?:\/\//, '').replace(/\W/g, '_')}`, capa: 1, sev: d.sev,
      nombre: `Dominio ${d.url.replace('https://', '')}`,
      async run() {
        const r = await pedir(d.url, { timeoutMs: U.timeoutMs, leerCuerpo: true });
        if (!r.ok) return { ok: false, detalle: r.error, ms: r.ms };
        if (r.code !== 200) return { ok: false, detalle: `HTTP ${r.code}`, ms: r.ms };
        if (!r.texto?.includes(cfg.sitio.marcadorHtml)) return { ok: false, detalle: 'HTTP 200 sin el marcador de contenido', ms: r.ms };
        return { ok: true, detalle: `HTTP 200 (${r.ms} ms)`, ms: r.ms };
      },
    });
  }

  add({
    id: 'certificado_tls', capa: 1, sev: 'aviso', nombre: 'Certificado TLS vigente',
    async run() {
      try {
        const c = await certificado(cfg.sitio.hostCert);
        if (!c?.valid_to) return { ok: false, detalle: 'no se pudo leer el certificado' };
        const emisor = c.issuer?.O || c.issuer?.CN || '?';

        // Si un antivirus/proxy local esta interceptando TLS, el certificado que vemos
        // es el suyo, no el de Firebase. Decirlo, en vez de dar una falsa tranquilidad.
        const interceptores = cfg.sitio.emisoresDeInterceptacion || [];
        if (interceptores.some((x) => emisor.toLowerCase().includes(x.toLowerCase())))
          return { ok: true, sev: 'info', detalle: `NO VALIDADO: un intermediario local ("${emisor}") esta interceptando TLS, asi que este no es el certificado real de Firebase. Esta revision solo es fiable desde la nube (GitHub Actions).` };

        const dias = Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000);
        if (dias <= U.certDiasCritico) return { ok: false, sev: 'critico', detalle: `vence en ${dias} dias (${c.valid_to})` };
        if (dias <= U.certDiasAviso) return { ok: false, detalle: `vence en ${dias} dias (${c.valid_to})` };
        return { ok: true, detalle: `vence en ${dias} dias, emisor ${emisor}` };
      } catch (e) { return { ok: false, detalle: `error TLS: ${e.message}` }; }
    },
  });

  add({
    id: 'dns', capa: 1, sev: 'aviso', nombre: 'DNS apunta a Firebase Hosting',
    async run() {
      try {
        const ips = await dnsp.resolve4(cfg.sitio.hostCert);
        const malas = ips.filter((ip) => !cfg.sitio.ipsEsperadas.includes(ip));
        return malas.length
          ? { ok: false, detalle: `IP inesperada: ${malas.join(', ')} (esperadas ${cfg.sitio.ipsEsperadas.join(', ')})` }
          : { ok: true, detalle: ips.join(', ') };
      } catch (e) { return { ok: false, detalle: `fallo la resolucion DNS: ${e.message}` }; }
    },
  });

  add({
    id: 'cdn', capa: 1, sev: 'info', nombre: 'CDN Fastly responde',
    async run(ctx) {
      const h = ctx.home?.headers;
      if (!h) return { ok: false, detalle: 'sin cabeceras' };
      const cache = h.get('x-cache'), srv = h.get('x-served-by');
      return { ok: !!cache, detalle: cache ? `x-cache: ${cache} via ${srv || '?'}` : 'sin cabecera x-cache' };
    },
  });

  add({
    id: 'deploy', capa: 1, sev: 'info', nombre: 'Version desplegada',
    async run(ctx) {
      const lm = ctx.home?.headers?.get('last-modified');
      const etag = ctx.home?.headers?.get('etag');
      return { ok: true, detalle: `${lm || 'sin last-modified'} · etag ${(etag || '').slice(1, 13)}` , meta: { lastModified: lm, etag } };
    },
  });

  // ═══════════ CAPA 2 — BACKEND Y DEPENDENCIAS ═══════════

  const revisarFuncion = (plantilla, def, gen) => ({
    id: `fn_${def.f.toLowerCase()}`, capa: 2, sev: def.sev,
    nombre: `Funcion ${gen} ${def.f} (${def.que})`,
    async run() {
      // SOLO GET sin cuerpo: no puede mover dinero ni crear registros.
      const r = await pedir(plantilla.replace('{f}', def.f), { timeoutMs: U.timeoutMs, leerCuerpo: true, maxBytes: 2000 });
      if (!r.ok) return { ok: false, detalle: `sin respuesta: ${r.error}`, ms: r.ms };
      if (r.code >= 500) return { ok: false, detalle: `HTTP ${r.code} (error del servidor)`, ms: r.ms };

      // Como distinguir "viva" de "ya no existe" (comprobado contra la plataforma real):
      //  - 403 + HTML "Forbidden"  -> Cloud Run rechaza la invocacion publica por IAM. VIVA.
      //  - 404 + "Cannot GET /"    -> el Express de la funcion contesto. VIVA.
      //  - 405 texto o JSON        -> la funcion contesto que el metodo no aplica. VIVA.
      //  - 404 con la pagina de error de Google ("Page not found") -> la funcion NO EXISTE.
      const cuerpo = r.texto || '';
      const es404DeGoogle = r.code === 404 && /Page not found|requested URL .*was not found/i.test(cuerpo);
      if (es404DeGoogle)
        return { ok: false, detalle: `HTTP 404 de la infraestructura de Google: la funcion NO EXISTE en el proyecto (pero el frontend la sigue llamando)`, ms: r.ms };

      const respondioLaApp = cfg.funciones.statusVivos.includes(r.code) || (r.code === 404 && /Cannot (GET|POST)/i.test(cuerpo));
      if (!respondioLaApp)
        return { ok: false, detalle: `HTTP ${r.code} inesperado`, ms: r.ms };

      const lento = r.ms > U.latenciaFuncionMs;
      return {
        ok: !lento, sev: lento ? 'aviso' : def.sev,
        detalle: lento ? `viva (HTTP ${r.code}) pero LENTA: ${r.ms} ms` : `viva (HTTP ${r.code}, ${r.ms} ms)`,
        ms: r.ms,
      };
    },
  });

  for (const d of cfg.funciones?.gen2 ?? []) add(revisarFuncion(cfg.funciones.plantillaGen2, d, 'gen2'));
  for (const d of cfg.funciones?.gen1 ?? []) add(revisarFuncion(cfg.funciones.plantillaGen1, d, 'gen1'));

  add({
    id: 'auth', capa: 2, sev: 'critico', nombre: 'Firebase Auth disponible',
    async run() {
      const r = await pedir(`https://identitytoolkit.googleapis.com/v1/projects?key=${cfg.firebase.apiKeyPublica}`,
        { timeoutMs: U.timeoutMs });
      if (!r.ok) return { ok: false, detalle: r.error, ms: r.ms };
      return { ok: r.code === 200, detalle: `HTTP ${r.code} (${r.ms} ms)`, ms: r.ms };
    },
  });

  // Reglas de Firestore, dirigido por datos. Cada entrada de configuracion dice
  // que coleccion se consulta y que acceso se espera (200 = lectura publica que la
  // app necesita, 403 = acceso restringido). El codigo no sabe ni le importa cuales
  // son: eso lo pone la configuracion del perfil que este activo.
  for (const c of cfg.firestore?.accesoEsperado ?? []) {
    const esperado = Number(c.http) || 200;
    add({
      id: `fs_acceso_${c.col}`, capa: 2, sev: c.sev || 'critico',
      nombre: `Firestore ${c.col}: acceso esperado ${esperado}${c.que ? ' (' + c.que + ')' : ''}`,
      async run() {
        const r = await fsListar(cfg, c.col, 1);
        if (!r.ok) return { ok: false, detalle: r.error, ms: r.ms };
        if (esperado === 200) {
          return r.code === 200
            ? { ok: true, detalle: `HTTP 200 (${r.ms} ms)`, ms: r.ms }
            : { ok: false, detalle: `esperaba lectura publica y obtuvo HTTP ${r.code}`, ms: r.ms };
        }
        return r.code === 200
          ? { ok: false, detalle: `esperaba acceso restringido y obtuvo HTTP 200`, ms: r.ms }
          : { ok: true, detalle: `acceso restringido, HTTP ${r.code} (${r.ms} ms)`, ms: r.ms };
      },
    });
  }

  for (const t of cfg.terceros ?? []) {
    add({
      id: `tercero_${t.id}`, capa: 2, sev: t.sev, nombre: `Tercero: ${t.que}`,
      async run() {
        const r = await pedir(t.url, { timeoutMs: U.timeoutMs });
        if (!r.ok) return { ok: false, detalle: r.error, ms: r.ms };
        return { ok: r.code === 200, detalle: `HTTP ${r.code} (${r.ms} ms)`, ms: r.ms };
      },
    });
  }

  // ═══════════ CAPA 3 — NEGOCIO ═══════════

  add({
    id: 'neg_resultados', capa: 3, sev: 'critico',
    nombre: 'Resultados de sorteos cargados al dia',
    async run(ctx) {
      // Se piden los ultimos 120 resultados por fecha y se filtra por juego del lado del monitor.
      // Se hace asi a proposito: la consulta filtrada por product exige un indice compuesto
      // en Firestore, y crear un indice seria un cambio en produccion.
      const r = await fsConsulta(cfg, 'gameResult', 'createdAt', 120);
      if (!r.ok) return { ok: false, detalle: `no se pudo consultar: ${r.error}`, ms: r.ms };
      if (r.code !== 200) return { ok: false, detalle: `HTTP ${r.code} al consultar gameResult`, ms: r.ms };

      let filas;
      try { filas = JSON.parse(r.texto); } catch { return { ok: false, detalle: 'respuesta no interpretable', ms: r.ms }; }
      if (filas[0]?.error) return { ok: false, detalle: `Firestore: ${filas[0].error.message}`.slice(0, 200), ms: r.ms };

      const ultimo = {};
      for (const f of filas) {
        if (!f.document) continue;
        const d = plano(f.document);
        const p = d.product; if (!p) continue;
        const ts = Date.parse(d.createdAt);
        if (!ultimo[p] || ts > ultimo[p].ts) ultimo[p] = { ts, sorteo: d.drawNumber };
      }
      ctx.resultados = ultimo;

      const atrasados = [], detalles = [];
      for (const j of cfg.juegos.resultados) {
        const u = ultimo[j.product];
        if (!u) { atrasados.push(`${j.product}: sin resultados en la ventana consultada`); continue; }
        const horas = (Date.now() - u.ts) / 3600000;
        detalles.push(`${j.product} #${u.sorteo} hace ${horas.toFixed(1)}h`);
        if (horas > j.maxHoras) atrasados.push(`${j.product}: ultimo #${u.sorteo} hace ${horas.toFixed(1)}h (max ${j.maxHoras}h, ${j.cal})`);
      }
      return atrasados.length
        ? { ok: false, detalle: `ATRASADOS -> ${atrasados.join(' | ')}`, ms: r.ms, meta: { detalles } }
        : { ok: true, detalle: detalles.join(' · '), ms: r.ms };
    },
  });

  add({
    id: 'neg_catalogo_home', capa: 3, sev: 'critico', secuencial: true,
    nombre: 'Catalogo del home con juegos activos',
    async run(ctx) {
      const r = await fsListar(cfg, 'gamesHome', 60);
      if (!r.ok || r.code !== 200) return { ok: false, detalle: r.error || `HTTP ${r.code}`, ms: r.ms };
      let j; try { j = JSON.parse(r.texto); } catch { return { ok: false, detalle: 'respuesta no interpretable', ms: r.ms }; }
      const docs = (j.documents || []).map(plano);
      ctx.gamesHome = docs;
      const activos = docs.filter((d) => String(d.isActive) === 'true');
      if (!activos.length) return { ok: false, detalle: `${docs.length} juegos en el catalogo pero NINGUNO activo -> el home se ve vacio`, ms: r.ms };
      return { ok: true, detalle: `${activos.length} juegos activos de ${docs.length} en el catalogo`, ms: r.ms };
    },
  });

  // El campo gamesHome.next SI se muestra al cliente en la tarjeta del juego como
  // "Proximo: DD/MM/AAAA" (verificado en el navegador el 2026-09-01). Pero solo lo usan
  // las quinielas: Chispazo, Tris y Melate toman esa fecha en vivo de las funciones.
  // Por eso se vigila unicamente la lista blanca de config, no los 17 juegos: en los
  // demas el campo esta abandonado y generaria alarma permanente.
  add({
    id: 'neg_proximo_sorteo', capa: 3, sev: 'aviso',
    nombre: 'Fecha de "Proximo sorteo" que ve el cliente esta vigente',
    omitirEn: 'ventaElectronicosCerrada',
    async run(ctx) {
      const docs = ctx.gamesHome;
      if (!docs) return { ok: false, detalle: 'no se pudo leer el catalogo' };
      const vigilar = cfg.juegos.vigilarProximoSorteo || [];
      const vencidos = [], revisados = [];
      for (const d of docs) {
        const nombre = d.shortName || d.name || '';
        if (String(d.isActive) !== 'true') continue;
        if (!vigilar.includes(nombre)) continue;
        revisados.push(nombre);
        if (!d.next) { vencidos.push(`${nombre}: sin fecha de proximo sorteo`); continue; }
        const t = Date.parse(d.next);
        if (Number.isNaN(t)) { vencidos.push(`${nombre}: fecha ilegible ("${String(d.next).slice(0, 24)}")`); continue; }
        const dias = (Date.now() - t) / 86400000;
        if (dias > 0) vencidos.push(`${nombre}: muestra ${new Date(t).toLocaleDateString('es-MX')} (hace ${dias.toFixed(0)}d)`);
      }
      if (!revisados.length) return { ok: true, detalle: 'ningun juego de la lista blanca esta activo' };
      return vencidos.length
        ? { ok: false, detalle: `FECHA PASADA a la vista del cliente -> ${vencidos.join(' | ')}` }
        : { ok: true, detalle: `${revisados.length} juegos con fecha vigente (${revisados.join(', ')})` };
    },
  });

  for (const v of cfg.juegos?.ventanaVenta ?? []) {
    add({
      id: `neg_venta_${v.col}`, capa: 3, sev: v.sev,
      nombre: `Ventana de venta abierta: ${v.que}`,
      omitirEn: 'ventaElectronicosCerrada',
      async run() {
        const r = await fsListar(cfg, v.col, 5);
        if (!r.ok || r.code !== 200) return { ok: false, detalle: r.error || `HTTP ${r.code}`, ms: r.ms };
        let j; try { j = JSON.parse(r.texto); } catch { return { ok: false, detalle: 'respuesta no interpretable', ms: r.ms }; }
        const docs = (j.documents || []).map(plano);
        if (!docs.length) return { ok: false, detalle: `no hay concurso cargado en ${v.col} -> no se puede jugar`, ms: r.ms };
        const ahora = Date.now();
        const abiertos = docs.filter((d) => {
          const a = Date.parse(d.saleDateOpen), c = Date.parse(d.saleDateClose);
          return !Number.isNaN(a) && !Number.isNaN(c) && ahora >= a && ahora < c;
        });
        if (abiertos.length) {
          const d = abiertos[0];
          const restan = ((Date.parse(d.saleDateClose) - ahora) / 3600000).toFixed(1);
          return { ok: true, detalle: `concurso ${d.draw || d._id} en venta, cierra en ${restan}h`, ms: r.ms };
        }

        // Que no haya nada en venta NO es de por si una falla: entre que cierra un
        // concurso y abre el siguiente hay un hueco natural. Solo es problema si ese
        // hueco se alarga, porque entonces el nuevo concurso no se cargo.
        const programado = docs
          .map((d) => ({ d, abre: Date.parse(d.saleDateOpen) }))
          .filter((x) => !Number.isNaN(x.abre) && x.abre > ahora)
          .sort((a, b) => a.abre - b.abre)[0];
        if (programado) {
          const faltan = ((programado.abre - ahora) / 3600000).toFixed(1);
          return { ok: true, detalle: `entre concursos: el siguiente (${programado.d.draw || programado.d._id}) ya esta cargado y abre en ${faltan}h`, ms: r.ms };
        }

        const cierres = docs.map((d) => Date.parse(d.saleDateClose)).filter((t) => !Number.isNaN(t) && t <= ahora);
        const tolerancia = (v.toleranciaHoras ?? cfg.juegos?.toleranciaVentaHoras ?? 12) * 3600000;
        if (cierres.length) {
          const desde = ahora - Math.max(...cierres);
          const horas = (desde / 3600000).toFixed(1);
          if (desde < tolerancia)
            return { ok: true, detalle: `entre concursos: la venta cerro hace ${horas}h y aun no abre la siguiente (normal hasta ${tolerancia / 3600000}h)`, ms: r.ms };
          return { ok: false, detalle: `sin concurso vendible desde hace ${horas}h (limite ${tolerancia / 3600000}h) -> el siguiente concurso no se ha cargado`, ms: r.ms };
        }

        const prox = docs.map((d) => `${d.draw || d._id}: ${String(d.saleDateOpen).slice(0, 16)} a ${String(d.saleDateClose).slice(0, 16)}`).join(' | ');
        return { ok: false, detalle: `ningun concurso en venta ni programado (${prox})`, ms: r.ms };
      },
    });
  }

  /**
   * Juegos con ciclo semanal: el concurso cierra un dia fijo y el siguiente tiene
   * que estar cargado antes de una hora limite. Que no haya concurso vigente NO es
   * falla mientras no se pase ese limite; pasado el limite, si lo es, porque
   * significa que nadie puede jugar.
   * Se lee del catalogo del home, que es exactamente lo que ve el visitante.
   */
  for (const d of cfg.juegos?.disponibilidad ?? []) {
    add({
      id: `neg_disp_${String(d.juego).replace(/\W/g, '')}`, capa: 3, sev: d.sev || 'critico',
      nombre: `Concurso cargado: ${d.juego}`,
      async run(ctx) {
        const docs = ctx.gamesHome;
        if (!docs) return { ok: false, detalle: 'no se pudo leer el catalogo del home' };
        const doc = docs.find((x) => [x.shortName, x.name].some((n) => String(n).toLowerCase() === String(d.juego).toLowerCase()));
        if (!doc) return { ok: false, detalle: `${d.juego} no aparece en el catalogo del home` };

        const campo = d.campoCierre || 'close';
        const crudo = doc[campo];
        const cierre = fechaFlexible(crudo);
        if (Number.isNaN(cierre))
          return { ok: false, detalle: `la fecha de cierre no es interpretable ("${String(crudo).slice(0, 44)}")` };

        const ahora = Date.now();
        if (cierre > ahora)
          return { ok: true, detalle: `concurso vigente, cierra en ${((cierre - ahora) / 3600000).toFixed(1)}h` };

        const limite = proximoDiaHora(cierre, d.limite?.dia, d.limite?.hora, cfg.tz);
        if (limite == null) return { ok: false, detalle: 'la regla de limite esta mal configurada' };

        const cerroHace = ((ahora - cierre) / 3600000).toFixed(1);
        if (ahora < limite)
          return { ok: true, detalle: `cerro hace ${cerroHace}h; el nuevo debe cargarse antes del ${d.limite.dia} ${d.limite.hora} (faltan ${((limite - ahora) / 3600000).toFixed(1)}h)` };

        return { ok: false, detalle: `cerro hace ${cerroHace}h y ya paso el limite (${d.limite.dia} ${d.limite.hora}) sin que se cargue el nuevo concurso -> no se puede jugar` };
      },
    });
  }

  add({
    id: 'neg_lotenal', capa: 3, sev: 'critico',
    nombre: 'Resultados de Loteria tradicional (billetes/cachitos)',
    async run() {
      const r = await fsConsulta(cfg, 'resultsLotenal', 'createdAt', 20);
      if (!r.ok || r.code !== 200) return { ok: false, detalle: r.error || `HTTP ${r.code}`, ms: r.ms };
      let filas; try { filas = JSON.parse(r.texto); } catch { return { ok: false, detalle: 'respuesta no interpretable', ms: r.ms }; }
      if (filas[0]?.error) return { ok: false, detalle: `Firestore: ${filas[0].error.message}`.slice(0, 200), ms: r.ms };
      const docs = filas.filter((f) => f.document).map((f) => plano(f.document));
      if (!docs.length) return { ok: false, detalle: 'sin resultados de Loteria tradicional', ms: r.ms };
      const d = docs[0];
      const horas = (Date.now() - Date.parse(d.createdAt)) / 3600000;
      // Los sorteos tradicionales son varias veces por semana; > 8 dias sin resultados es sospechoso.
      return horas > 192
        ? { ok: false, detalle: `ultimo resultado (${d.drawName} #${d.drawNumber}) hace ${(horas / 24).toFixed(1)} dias`, ms: r.ms }
        : { ok: true, detalle: `ultimo: ${d.drawName} #${d.drawNumber} hace ${horas.toFixed(1)}h`, ms: r.ms };
    },
  });

  return R;
}

// ─────────────────────────── ejecucion, estado y alertas ───────────────────────────

/** Ejecuta fn sobre items con como maximo n en vuelo a la vez, conservando el orden. */
async function enTandas(items, n, fn) {
  const salida = new Array(items.length);
  let i = 0;
  const obreros = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; salida[k] = await fn(items[k]); }
  });
  await Promise.all(obreros);
  return salida;
}

async function correr(cfg, capas, opciones) {
  const desactivadas = new Set(cfg.desactivadas?.ids || []);
  const revisiones = construirRevisiones(cfg)
    .filter((r) => capas.includes(r.capa) && !desactivadas.has(r.id));
  const ctx = {};
  const concurrencia = cfg.umbrales.concurrencia || 8;

  const ejecutar = async (rev) => {
    if (rev.omitirEn && cfg.ventanas[rev.omitirEn] && enVentana(cfg.ventanas[rev.omitirEn], cfg.tz)) {
      const v = cfg.ventanas[rev.omitirEn];
      return { ...meta(rev), omitida: true, ok: true, detalle: `omitida por la ventana ${rev.omitirEn} (${v.desde}-${v.hasta})` };
    }
    let out;
    try { out = await rev.run(ctx); }
    catch (e) { out = { ok: false, detalle: `error en la revision: ${e.message}` }; }
    return { ...meta(rev), ...out, sev: out.sev || rev.sev };
  };

  // Por capa: primero las revisiones marcadas `secuencial` (alimentan el contexto que
  // usan las demas: el HTML del home, el catalogo de juegos), luego el resto en paralelo.
  const resultados = [];
  for (const capa of [1, 2, 3]) {
    if (!capas.includes(capa)) continue;
    const deLaCapa = revisiones.filter((r) => r.capa === capa);
    for (const rev of deLaCapa.filter((r) => r.secuencial)) resultados.push(await ejecutar(rev));
    const resto = deLaCapa.filter((r) => !r.secuencial);
    resultados.push(...await enTandas(resto, concurrencia, ejecutar));
  }
  return { resultados, ctx };
}

const meta = (r) => ({ id: r.id, capa: r.capa, nombre: r.nombre, sev: r.sev });

function evaluarEstado(cfg, resultados, opciones) {
  const estado = leerJson(F_STATUS, { checks: {}, ultimaCorrida: null });
  const ahora = Date.now(), iso = new Date(ahora).toISOString();
  const alertas = [];
  const reconocidos = new Set(cfg.reconocidos?.ids || []);

  for (const r of resultados) {
    const e = estado.checks[r.id] || { ok: true, fallosSeguidos: 0, desde: iso, alertado: false, ultimaAlerta: null };

    if (r.omitida) { estado.checks[r.id] = { ...e, omitidaEn: iso }; continue; }

    if (!r.ok) {
      e.fallosSeguidos = (e.fallosSeguidos || 0) + 1;
      if (e.ok) { e.ok = false; e.desde = iso; }
      const alcanzoUmbral = e.fallosSeguidos >= cfg.umbrales.fallosParaAlertar;
      const reaviso = e.alertado && e.ultimaAlerta && (ahora - Date.parse(e.ultimaAlerta)) >= cfg.umbrales.reavisoMinutos * 60000;
      const alertable = cfg.alertas.severidadesQueAlertan.includes(r.sev) && !reconocidos.has(r.id);
      if (alcanzoUmbral && alertable && (!e.alertado || reaviso)) {
        alertas.push({ tipo: e.alertado ? 'sigue' : 'abre', ...r, desde: e.desde, fallos: e.fallosSeguidos });
        e.ultimaAlerta = iso;
        if (!e.alertado) {
          e.alertado = true;
          appendFileSync(F_INCIDENTES, JSON.stringify({ ts: iso, evento: 'abre', id: r.id, sev: r.sev, nombre: r.nombre, detalle: r.detalle }) + '\n');
        }
      }
    } else {
      if (!e.ok) {
        const minutos = ((ahora - Date.parse(e.desde)) / 60000).toFixed(0);
        if (e.alertado) alertas.push({ tipo: 'cierra', ...r, duracionMin: minutos });
        appendFileSync(F_INCIDENTES, JSON.stringify({ ts: iso, evento: 'cierra', id: r.id, nombre: r.nombre, duracionMin: Number(minutos) }) + '\n');
      }
      e.ok = true; e.fallosSeguidos = 0; e.alertado = false; e.ultimaAlerta = null; e.desde = e.desde || iso;
    }
    e.ultimoDetalle = r.detalle; e.ultimoMs = r.ms ?? null;
    estado.checks[r.id] = e;
  }

  estado.ultimaCorrida = iso;
  if (!opciones.dryRun) writeFileSync(F_STATUS, JSON.stringify(estado, null, 2));
  return { estado, alertas };
}

async function mandarTelegram(cfg, alertas, resumen) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { enviado: false, motivo: 'faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID en .env' };
  if (!alertas.length) return { enviado: false, motivo: 'sin alertas que mandar' };

  const ic = { abre: '\u{1F534}', sigue: '\u{1F7E0}', cierra: '\u{2705}' };
  const lineas = [`<b>${cfg.nombre} — monitoreo</b>`, `<i>${new Date().toLocaleString('es-MX', { timeZone: cfg.tz })}</i>`, ''];
  for (const a of alertas) {
    const t = a.tipo === 'cierra' ? `RESUELTO (${a.duracionMin} min)` : a.tipo === 'sigue' ? 'SIGUE FALLANDO' : a.sev.toUpperCase();
    lineas.push(`${ic[a.tipo]} <b>${t}</b> — ${a.nombre}`);
    lineas.push(`   <code>${String(a.detalle).slice(0, 300)}</code>`, '');
  }
  lineas.push(`<i>${resumen}</i>`);

  const r = await pedir(`https://api.telegram.org/bot${token}/sendMessage`, {
    metodo: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 15000, leerCuerpo: true,
    cuerpo: JSON.stringify({ chat_id: chat, text: lineas.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return r.ok && r.code === 200 ? { enviado: true } : { enviado: false, motivo: `Telegram HTTP ${r.code}: ${String(r.texto).slice(0, 200)}` };
}

/** Revisa que las credenciales de Telegram existan y tengan buena forma. Nunca imprime valores. */
function revisarCredenciales() {
  const t = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const c = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const problemas = [];
  if (!t) problemas.push('TELEGRAM_BOT_TOKEN esta vacio en .env — pega el token que te dio @BotFather despues del signo =');
  else if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t))
    problemas.push(`TELEGRAM_BOT_TOKEN no tiene forma de token de Telegram (debe ser numeros:letras, p.ej. 8123456789:AAH...). Lo que hay tiene ${t.length} caracteres.`);
  if (!c) problemas.push('TELEGRAM_CHAT_ID esta vacio en .env');
  else if (!/^-?\d+$/.test(c)) problemas.push('TELEGRAM_CHAT_ID debe ser solo numeros (puede empezar con - si es un grupo)');
  return problemas;
}

/** --chatid : lista los chats que el bot conoce, para encontrar el id del grupo. */
async function chatid() {
  console.log('\n  ' + C.fuerte('Chats que conoce tu bot'));
  console.log(C.gris('  ' + '─'.repeat(76)));

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) { console.log(C.rojo('\n  Falta TELEGRAM_BOT_TOKEN en .env\n')); process.exitCode = 2; return; }

  const r = await pedir(`https://api.telegram.org/bot${token}/getUpdates?limit=100`,
    { timeoutMs: 20000, leerCuerpo: true, maxBytes: 500000 });
  if (!r.ok || r.code !== 200) {
    console.log(C.rojo(`\n  Telegram respondio HTTP ${r.code}. ${r.code === 401 ? 'Token invalido.' : ''}\n`));
    process.exitCode = 2; return;
  }

  let updates = [];
  try { updates = JSON.parse(r.texto).result || []; } catch { /* ignorar */ }

  // Un chat puede aparecer en varios tipos de update. El de "me agregaron al grupo"
  // (my_chat_member) es el que sale al meter el bot a un grupo nuevo.
  const chats = new Map();
  for (const u of updates) {
    for (const donde of [u.message, u.edited_message, u.channel_post, u.my_chat_member, u.callback_query?.message]) {
      const c = donde?.chat; if (!c) continue;
      chats.set(c.id, { id: c.id, tipo: c.type, nombre: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
    }
  }

  if (!chats.size) {
    console.log(C.ama(`
  Telegram no reporta ningun chat todavia. Para que aparezca el grupo:

    1. Crea el grupo en Telegram.
    2. Agrega tu bot al grupo (menu del grupo -> Agregar miembro -> busca tu bot).
    3. Escribe en el grupo:  /start
       (los bots en grupos solo "oyen" mensajes que empiezan con /, por privacidad)
    4. Vuelve a correr:  node monitor.mjs --chatid
`));
    return;
  }

  const actual = (process.env.TELEGRAM_CHAT_ID || '').trim();
  console.log('');
  for (const c of chats.values()) {
    const esGrupo = c.tipo === 'group' || c.tipo === 'supergroup';
    const marca = String(c.id) === actual ? C.verde('  <- el que usa .env ahora') : '';
    console.log(`    ${esGrupo ? C.verde('GRUPO') : C.gris('privado')}   id ${C.fuerte(String(c.id).padEnd(16))} ${c.nombre}${marca}`);
  }
  console.log(C.gris(`
  Pega el id del grupo en TELEGRAM_CHAT_ID dentro de .env y comprueba con:
      node monitor.mjs --prueba

  Ojo: los ids de grupo son negativos. Si Telegram convierte el grupo en
  "supergrupo" (pasa al activar historial o al agregar admins), el id CAMBIA
  de -123456789 a -100123456789 y hay que actualizarlo.
`));
}

/**
 * --explorar-juegos : con la cuenta de prueba, averigua que devuelve la funcion de
 * catalogo para cada juego. Sirve para escribir las revisiones sobre datos reales
 * en vez de suponer. No manda nada a Telegram y no escribe estado.
 */
async function explorarJuegos(cfg, juegos) {
  console.log('\n  ' + C.fuerte('Exploracion del catalogo de juego (requiere cuenta de prueba)'));
  console.log(C.gris('  ' + '─'.repeat(76)));

  const s = await sesionDePrueba(cfg);
  if (!s) {
    console.log(C.ama(`
  Faltan las credenciales de la cuenta de prueba. En el archivo .env agrega:

      CM_USUARIO_PRUEBA=correo-de-la-cuenta-de-prueba
      CM_PASSWORD_PRUEBA=su-contrasena

  Archivo: ${join(RAIZ, '.env')}
  Usa una cuenta DEDICADA, con saldo cero y sin metodo de pago.
`));
    process.exitCode = 2; return;
  }
  if (s.error) {
    console.log(C.rojo(`\n  No se pudo iniciar sesion: ${s.error}`));
    const pistas = {
      EMAIL_NOT_FOUND: 'ese correo no esta registrado en la plataforma',
      INVALID_PASSWORD: 'la contrasena no coincide',
      INVALID_LOGIN_CREDENTIALS: 'correo o contrasena incorrectos',
      USER_DISABLED: 'la cuenta esta deshabilitada',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'demasiados intentos; espera un rato',
    };
    for (const [k, v] of Object.entries(pistas)) if (String(s.error).includes(k)) console.log(C.gris(`  (${v})`));
    console.log('');
    process.exitCode = 2; return;
  }
  console.log(C.verde('\n  Sesion iniciada correctamente.\n'));

  const resumen = (r) => {
    if (r.error) return r.error;
    if (r.datos && typeof r.datos === 'object') {
      if (Array.isArray(r.datos)) return `[array de ${r.datos.length}] ` + JSON.stringify(r.datos[0] || {}).slice(0, 120);
      if (r.datos.message) return `${r.datos.code || ''} ${r.datos.message}`.trim();
      return 'claves: ' + Object.keys(r.datos).join(', ').slice(0, 130);
    }
    return String(r.texto || '').slice(0, 120);
  };

  // FASE 1 — descubrir el endpoint y el nombre del parametro. Las rutas son GET;
  // con POST responden 405. Se prueba con un solo juego para no hacer ruido.
  const muestra = juegos[0];
  const candidatos = [
    ['getgameinfofunction', null], ['getgameinfofunction', { game: muestra }],
    ['getgameinfofunction', { gameName: muestra }], ['getgameinfofunction', { product: muestra }],
    ['getgameinfofunction', { name: muestra }], ['getgameinfofunction', { id: muestra }],
    ['draws', null], ['draws', { game: muestra }], ['draws', { product: muestra }],
    ['prizes', null], ['prizes', { game: muestra }],
  ];

  console.log(C.fuerte(`  FASE 1 — buscando el endpoint correcto (muestra: ${muestra})\n`));
  let bueno = null;
  for (const [fn, params] of candidatos) {
    const r = await llamarConSesion(cfg, fn, params);
    const marca = r.code === 200 ? C.verde('200') : C.gris(String(r.code || 'err'));
    const etiqueta = `${fn}${params ? '?' + Object.keys(params)[0] + '=' : ''}`;
    console.log(`     ${marca}  ${etiqueta.padEnd(34)} ${C.gris(resumen(r))}`);
    if (r.code === 200 && !bueno) { bueno = { fn, params }; console.log(C.verde('           ^ este responde')); }
  }

  if (!bueno) {
    console.log(C.ama(`
  Ninguna combinacion respondio 200. Pegame esta salida y sigo probando; puede
  que la ruta lleve el juego en el camino (/algo/Melate) o que espere otro nombre
  de parametro. Tambien sirve preguntarle al equipo como consulta la app el
  estado del sorteo abierto.
`));
    return;
  }

  // FASE 2 — con la forma que funciona, se consulta cada juego.
  console.log('\n  ' + C.fuerte(`FASE 2 — ${bueno.fn} para cada juego\n`));
  for (const g of juegos) {
    const params = bueno.params ? { [Object.keys(bueno.params)[0]]: g } : null;
    const r = await llamarConSesion(cfg, bueno.fn, params);
    console.log(`  ── ${C.fuerte(g)}  ${r.code === 200 ? C.verde('200') : C.gris(String(r.code))}  ${C.gris((r.ms || 0) + ' ms')}`);
    console.log(C.gris('     ' + JSON.stringify(r.datos ?? r.texto ?? r.error).slice(0, 900)));
  }
  console.log(C.gris('\n  Con esto puedo escribir la revision sobre el dato real.\n'));
}

/** --prueba : manda a Telegram un ejemplo de como se ven las alertas de verdad. */
async function prueba(cfg) {
  console.log('\n  ' + C.fuerte('Prueba de alertas por Telegram'));
  console.log(C.gris('  ' + '─'.repeat(76)));

  const problemas = revisarCredenciales();
  if (problemas.length) {
    console.log(C.rojo('\n  No puedo mandar la prueba todavia:\n'));
    for (const p of problemas) console.log('    • ' + p);
    console.log(C.gris(`
  Como obtener cada dato:
    1. En Telegram, escribe a @BotFather  ->  /newbot  ->  te da el token.
    2. Escribele cualquier cosa a tu bot nuevo (si no, Telegram no te deja mandarle nada).
    3. Abre  https://api.telegram.org/bot<TU_TOKEN>/getUpdates  y copia result[0].message.chat.id
    4. Pega los dos valores en .env (archivo: ${join(RAIZ, '.env')})
`));
    process.exitCode = 2;
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN.trim();

  // 1) Comprobar que el token es valido y de quien es el bot.
  const quien = await pedir(`https://api.telegram.org/bot${token}/getMe`, { timeoutMs: 15000, leerCuerpo: true });
  if (!quien.ok || quien.code !== 200) {
    console.log(C.rojo(`\n  Telegram rechazo el token (HTTP ${quien.code}).`));
    if (quien.code === 401) console.log('  401 = token invalido o revocado. Genera otro con @BotFather (/mybots -> API Token).');
    console.log(C.gris(`  Respuesta: ${String(quien.texto).slice(0, 200)}\n`));
    process.exitCode = 2;
    return;
  }
  let bot = {};
  try { bot = JSON.parse(quien.texto).result || {}; } catch { /* ignorar */ }
  console.log(C.verde(`\n  Token valido. Bot: @${bot.username || '?'} ("${bot.first_name || '?'}")`));

  // 2) Datos reales para que el ejemplo no sea inventado.
  console.log(C.gris('  Midiendo el sitio para incluir datos reales en el ejemplo...'));
  const { resultados } = await correr(cfg, [1], { dryRun: true });
  const reales = resultados.filter((r) => !r.omitida);
  const home = reales.find((r) => r.id === 'home');
  const resumen = `${reales.filter((r) => r.ok).length}/${reales.length} revisiones OK · home en ${home?.ms ?? '?'} ms`;

  // 3) Tres ejemplos de los tres tipos de aviso que existen.
  const ejemplos = [
    { tipo: 'abre',   sev: 'critico', nombre: '[EJEMPLO] El bundle JS que pide el HTML existe',
      detalle: 'main.abc123.js devuelve HTTP 404 -> PANTALLA BLANCA: el HTML pide un archivo que no existe' },
    { tipo: 'abre',   sev: 'critico', nombre: '[EJEMPLO] Ventana de venta abierta: Progol',
      detalle: 'ningun concurso en venta ahora mismo -> los clientes no pueden jugar' },
    { tipo: 'cierra', sev: 'critico', nombre: '[EJEMPLO] Funcion gen2 nuvei (pasarela de pago)', duracionMin: 14,
      detalle: 'viva (HTTP 403, 181 ms)' },
  ];

  const r = await mandarTelegram(cfg, ejemplos, `PRUEBA — no es una alerta real. Estado actual: ${resumen}`);
  console.log(r.enviado
    ? C.verde('\n  Mensaje de prueba enviado. Revisa tu Telegram.\n')
    : C.rojo(`\n  No se pudo enviar: ${r.motivo}\n`));
  if (!r.enviado) process.exitCode = 2;
}

function imprimir(cfg, resultados, alertas, tMs) {
  const t = ahoraEn(cfg.tz);
  const ventana = Object.entries(cfg.ventanas).filter(([, v]) => enVentana(v, cfg.tz)).map(([k]) => k);
  console.log('');
  console.log(C.fuerte(`  cm-monitor · ${cfg.nombre}`) + C.gris(`   ${t.fecha} ${t.hhmm} (${cfg.tz})`));
  if (ventana.length) console.log(C.gris(`  ventana activa: ${ventana.join(', ')}`));
  console.log(C.gris('  ' + '─'.repeat(76)));

  let capa = null;
  for (const r of resultados) {
    if (r.capa !== capa) {
      capa = r.capa;
      const t = { 1: 'CAPA 1 · Disponibilidad', 2: 'CAPA 2 · Backend y dependencias', 3: 'CAPA 3 · Negocio' }[capa];
      console.log('\n  ' + C.fuerte(t));
    }
    if (r.omitida) { console.log(`    ${C.gris('○')} ${C.gris(r.nombre)} ${C.gris('— ' + r.detalle)}`); continue; }
    const icono = r.ok ? C.verde('✔') : PINTA[r.sev](ICONO[r.sev]);
    const nombre = r.ok ? r.nombre : PINTA[r.sev](r.nombre);
    console.log(`    ${icono} ${nombre}`);
    console.log(`      ${C.gris(String(r.detalle).slice(0, 300))}`);
  }

  const reales = resultados.filter((r) => !r.omitida);
  const fallos = reales.filter((r) => !r.ok);
  const crit = fallos.filter((r) => r.sev === 'critico').length;
  const avi = fallos.filter((r) => r.sev === 'aviso').length;
  console.log('\n  ' + C.gris('─'.repeat(76)));
  const linea = `  ${reales.length - fallos.length}/${reales.length} OK` +
    (crit ? C.rojo(`  ·  ${crit} critico(s)`) : '') +
    (avi ? C.ama(`  ·  ${avi} aviso(s)`) : '') +
    C.gris(`  ·  ${(tMs / 1000).toFixed(1)}s`);
  console.log(linea);
  if (!fallos.length) console.log(C.verde('  Todo en orden.'));
  console.log('');
  return { total: reales.length, ok: reales.length - fallos.length, crit, avi };
}

/**
 * Deja un texto apto para un parametro de plantilla de WhatsApp.
 * Meta rechaza el mensaje con "Param text cannot have new-line/tab characters or
 * more than 4 consecutive spaces", asi que hay que aplanarlo antes de enviarlo.
 */
function limpiarParametro(s, max = 900) {
  const t = String(s ?? '')
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, max);
  return t || 'sin detalle';
}

/** Reduce todas las alertas de una corrida a los 3 huecos de la plantilla. */
function resumirAlertas(alertas) {
  const orden = { critico: 0, aviso: 1, info: 2 };
  const abiertas = alertas.filter((a) => a.tipo !== 'cierra');
  const principal = (abiertas.length ? abiertas : alertas)
    .slice().sort((a, b) => (orden[a.sev] ?? 9) - (orden[b.sev] ?? 9))[0];
  return {
    tipo: principal.tipo === 'cierra' ? 'RESUELTO' : String(principal.sev || 'aviso').toUpperCase(),
    nombre: alertas.length > 1 ? `${principal.nombre} y ${alertas.length - 1} mas` : principal.nombre,
    detalle: alertas.map((a) => `${a.tipo === 'cierra' ? '[OK]' : '[!]'} ${a.nombre}: ${a.detalle}`).join(' | '),
  };
}

/**
 * Manda una alerta por WhatsApp Cloud API (Meta).
 * WhatsApp NO permite texto libre iniciado por el negocio: solo plantillas
 * aprobadas. Por eso todo va en UNA plantilla de 3 variables, que sirve igual
 * para alertas y para el reporte diario (asi solo hay que aprobar una).
 */
async function mandarWhatsapp(cfg, partes) {
  const w = cfg.alertas?.whatsapp || {};
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const destinos = (process.env.WHATSAPP_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!token || !phoneId || !destinos.length)
    return { enviado: false, motivo: 'faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TO' };

  const version = w.apiVersion || 'v21.0';
  const max = w.maxParametro || 900;
  const parametros = [partes.tipo, partes.nombre, partes.detalle]
    .map((p) => ({ type: 'text', text: limpiarParametro(p, max) }));

  const fallos = [];
  for (const destino of destinos) {
    const r = await pedir(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      metodo: 'POST', timeoutMs: 20000, leerCuerpo: true, maxBytes: 4000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      cuerpo: JSON.stringify({
        messaging_product: 'whatsapp',
        to: destino,
        type: 'template',
        template: {
          name: w.plantilla || 'cm_monitoreo',
          language: { code: w.idioma || 'es_MX' },
          components: [{ type: 'body', parameters: parametros }],
        },
      }),
    });
    if (!r.ok) { fallos.push(`${destino}: ${r.error}`); continue; }
    if (r.code !== 200) {
      let msg = String(r.texto).slice(0, 300);
      try { msg = JSON.parse(r.texto).error?.message || msg; } catch { /* ignorar */ }
      fallos.push(`${destino}: HTTP ${r.code} — ${msg}`);
    }
  }
  return fallos.length ? { enviado: false, motivo: fallos.join(' ; ') } : { enviado: true };
}

/** Manda una alerta por todos los canales configurados en alertas.canales. */
async function notificar(cfg, alertas, resumen) {
  const canales = cfg.alertas?.canales?.length ? cfg.alertas.canales : ['telegram'];
  const partes = resumirAlertas(alertas);
  const salida = [];
  if (canales.includes('telegram')) salida.push(['Telegram', await mandarTelegram(cfg, alertas, resumen)]);
  if (canales.includes('whatsapp'))
    salida.push(['WhatsApp', await mandarWhatsapp(cfg, { ...partes, detalle: `${partes.detalle} — ${resumen}` })]);
  return salida;
}

/** Manda por Telegram el texto de un reporte (no una alerta). */
async function mandarReporte(cfg, texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { enviado: false, motivo: 'faltan credenciales de Telegram' };
  const escapa = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cuerpo = escapa(texto).slice(0, 3800);
  const r = await pedir(`https://api.telegram.org/bot${token}/sendMessage`, {
    metodo: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 15000, leerCuerpo: true,
    cuerpo: JSON.stringify({
      chat_id: chat,
      text: `<b>${cfg.nombre} — reporte</b>\n<pre>${cuerpo}</pre>`,
      parse_mode: 'HTML', disable_web_page_preview: true,
    }),
  });
  return r.ok && r.code === 200 ? { enviado: true } : { enviado: false, motivo: `Telegram HTTP ${r.code}: ${String(r.texto).slice(0, 200)}` };
}

function reporte(cfg) {
  if (!existsSync(F_HISTORIAL)) { console.log('Todavia no hay historial. Corre el monitor primero.'); return null; }
  const desde = Date.now() - 24 * 3600000;
  const filas = readFileSync(F_HISTORIAL, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x && Date.parse(x.ts) >= desde);

  // Se arma el texto plano una sola vez: sirve para la consola y para Telegram.
  const L = [];
  const di = (s = '') => L.push(s);

  di(`Reporte de las ultimas 24 h`);
  di('─'.repeat(52));
  if (!filas.length) { di('Sin corridas en las ultimas 24 h.'); console.log('\n  ' + L.join('\n  ') + '\n'); return L.join('\n'); }

  const porCheck = {};
  for (const f of filas) for (const [id, c] of Object.entries(f.checks || {})) {
    porCheck[id] ??= { nombre: c.nombre, corridas: 0, ok: 0, ms: [] };
    porCheck[id].corridas++;
    if (c.ok) porCheck[id].ok++;
    if (typeof c.ms === 'number') porCheck[id].ms.push(c.ms);
  }
  const p95 = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : null;

  di(`Corridas: ${filas.length}  ·  de ${filas[0].ts.slice(5, 16)} a ${filas.at(-1).ts.slice(5, 16)} UTC`);
  di();

  const orden = Object.entries(porCheck).sort((a, b) => (a[1].ok / a[1].corridas) - (b[1].ok / b[1].corridas));
  const conFalla = orden.filter(([, v]) => v.ok < v.corridas);

  if (!conFalla.length) di('Todas las revisiones al 100%.');
  else {
    di(`Revisiones con fallas (${conFalla.length}):`);
    for (const [id, v] of conFalla)
      di(`  ${(100 * v.ok / v.corridas).toFixed(1).padStart(5)}%  ${(v.nombre || id).slice(0, 44)}`);
  }

  di();
  const lentas = orden.map(([id, v]) => [v.nombre || id, p95(v.ms)]).filter(([, m]) => m != null)
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (lentas.length) {
    di('Las 5 mas lentas (p95):');
    for (const [n, m] of lentas) di(`  ${String(m).padStart(6)} ms  ${n.slice(0, 44)}`);
  }

  let inc = [];
  if (existsSync(F_INCIDENTES)) {
    inc = readFileSync(F_INCIDENTES, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && Date.parse(x.ts) >= desde);
  }
  di();
  di(`Incidentes: ${inc.length}`);
  for (const i of inc.slice(-15))
    di(`  ${i.ts.slice(5, 16)}  ${i.evento === 'abre' ? 'ABRE  ' : 'CIERRA'}  ${String(i.nombre).slice(0, 40)}${i.duracionMin != null ? ` (${i.duracionMin} min)` : ''}`);

  const texto = L.join('\n');
  // En consola se colorea el porcentaje; el texto plano es el que va a Telegram.
  console.log('\n  ' + texto.split('\n').map((l) => {
    const m = l.match(/^\s*(\d+(?:\.\d+)?)%/);
    if (!m) return l;
    const up = Number(m[1]);
    const color = up >= 99.5 ? C.verde : up >= 95 ? C.ama : C.rojo;
    return l.replace(/(\d+(?:\.\d+)?%)/, color('$1'));
  }).join('\n  ') + '\n');
  return texto;
}

/**
 * Corriendo cada 5 min son ~288 lineas al dia. Se recorta para que el historial
 * no crezca sin limite (importante en GitHub Actions, donde viaja en el cache).
 * Se revisa por tamano de archivo para no leerlo completo en cada corrida.
 */
function rotarHistorial(maxLineas = 20000) {
  try {
    if (statSync(F_HISTORIAL).size < 6 * 1024 * 1024) return;
    const lineas = readFileSync(F_HISTORIAL, 'utf8').split('\n').filter(Boolean);
    if (lineas.length > maxLineas) writeFileSync(F_HISTORIAL, lineas.slice(-maxLineas).join('\n') + '\n');
  } catch { /* si falla, mejor seguir monitoreando que abortar por el historial */ }
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  cargarEnv();
  const argv = process.argv.slice(2);
  const tiene = (f) => argv.includes(f);
  const valor = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  const cfg = cargarConfig({ soloPublico: tiene('--publico') });
  if (!cfg) { console.error('No pude leer checks.config.json'); process.exit(2); }

  if (tiene('--reporte')) {
    const texto = reporte(cfg);
    if (texto && tiene('--enviar')) {
      const r = await mandarReporte(cfg, texto);
      console.log(r.enviado ? C.verde('  Reporte enviado por Telegram.\n') : C.ama(`  Reporte NO enviado: ${r.motivo}\n`));
    }
    return;
  }
  if (tiene('--prueba')) { await prueba(cfg); return; }
  if (tiene('--chatid')) { await chatid(); return; }
  if (tiene('--explorar-juegos')) {
    const lista = (valor('--juegos') || 'Melate,MelateRetro,Chispazo,Tris,GanaGato,MiProgol').split(',').map((x) => x.trim()).filter(Boolean);
    await explorarJuegos(cfg, lista);
    return;
  }

  const capas = (valor('--capa') || '1,2,3').split(',').map(Number).filter((n) => [1, 2, 3].includes(n));
  const opciones = { dryRun: tiene('--dry-run'), json: tiene('--json') };

  // Las capas 2 y 3 necesitan el projectId y la API key publica, que se leen
  // en vivo del sitio si la configuracion no los trae (caso del repo publico).
  if (capas.some((c) => c >= 2)) await asegurarFirebase(cfg);

  const t0 = Date.now();
  const { resultados } = await correr(cfg, capas, opciones);
  const tMs = Date.now() - t0;

  const { alertas } = evaluarEstado(cfg, resultados, opciones);

  if (opciones.json) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), tMs, resultados, alertas }, null, 2));
  } else {
    const res = imprimir(cfg, resultados, alertas, tMs);
    if (alertas.length && !opciones.dryRun) {
      const r = await mandarTelegram(cfg, alertas, `${res.ok}/${res.total} revisiones OK`);
      console.log(r.enviado ? C.verde(`  Alerta enviada por Telegram (${alertas.length} evento(s)).\n`) : C.ama(`  Alerta NO enviada: ${r.motivo}\n`));
    } else if (alertas.length && opciones.dryRun) {
      console.log(C.ama(`  --dry-run: se habrian mandado ${alertas.length} alerta(s) por Telegram.\n`));
    }
  }

  if (!opciones.dryRun) {
    const linea = {
      ts: new Date().toISOString(), tMs, capas,
      checks: Object.fromEntries(resultados.filter((r) => !r.omitida).map((r) => [r.id, { nombre: r.nombre, ok: r.ok, sev: r.sev, ms: r.ms ?? null }])),
    };
    appendFileSync(F_HISTORIAL, JSON.stringify(linea) + '\n');
    rotarHistorial();
  }

  const criticosAbiertos = resultados.filter((r) => !r.omitida && !r.ok && r.sev === 'critico').length;
  process.exit(criticosAbiertos ? 1 : 0);
}

main().catch((e) => { console.error('Error inesperado:', e); process.exit(3); });
