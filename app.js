// Bandera de Seguridad · Regla 5.13
// Registra colocación y retiro de la bandera con foto tomada en el momento (marca de agua incrustada)
// y cuenta el tiempo que la bandera permanece colocada. Cada registro se guarda primero en este
// dispositivo (IndexedDB) y luego se envía a Shop Car a nombre del usuario que inició sesión; si no
// hay señal queda pendiente y se reintenta solo.
// Solo puede haber una bandera abierta por localidad y vía: para colocar otra, la abierta se retira
// o se cierra indicando el motivo por el que no se retiró (Shop Car lo hace cumplir también).

const $ = s => document.querySelector(s);
const FOLIO_KEY = 'bandera513-folio';
const LOCALIDAD_KEY = 'bandera513-localidad'; // última localidad usada, para no reescribirla
const CATALOGO_KEY = 'bandera513-localidades'; // catálogo de Localidades de Shop Car, para usarlo sin señal
const MAX_LADO = 1600;              // px del lado mayor de la foto guardada
const ANTIGUEDAD_MAX_MS = 10 * 60e3; // una foto más vieja que esto no se considera tomada en el momento

// ---------- Base de datos ----------
let db;
function abrirDB() {
  return new Promise((ok, mal) => {
    const r = indexedDB.open('bandera513', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('registros', { keyPath: 'id' });
    r.onsuccess = () => ok(db = r.result);
    r.onerror = () => mal(r.error);
  });
}
function tx(modo, fn) {
  return new Promise((ok, mal) => {
    const t = db.transaction('registros', modo), st = t.objectStore('registros');
    const r = fn(st);
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => mal(t.error);
  });
}
const todos = () => tx('readonly', st => st.getAll());
const guardar = reg => tx('readwrite', st => st.put(reg));
const borrar = id => tx('readwrite', st => st.delete(id));

// ---------- Utilidades ----------
const dos = n => String(n).padStart(2, '0');
function fechaHora(ms) {
  const d = new Date(ms);
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}
function duracion(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? `${d} d ` : '') + `${dos(h)}:${dos(m)}:${dos(s % 60)}`;
}
// Los registros anteriores guardaban vía y equipo juntos en `ubicacion` y no tenían "colocó".
const viaDe = r => r.via ?? r.ubicacion ?? '';
const colocoDe = r => r.coloco || r.colocacion.responsable || 'Sin nombre';
const lugar = r => [r.localidad, viaDe(r), r.equipo].filter(Boolean).join(' · ');
const abierta = r => !r.retiro && !r.cierre;
const finDe = r => r.retiro?.ms ?? r.cierre?.ms;
// Igual que fn_bandera_clave de Shop Car: "Vía 3", "via 3" y " VÍA  3 " son la misma vía.
const clave = t => String(t ?? '').trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function avisar(txt, ms = 3200) {
  const a = $('#aviso'); a.textContent = txt; a.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => a.hidden = true, ms);
}
function siguienteFolio(ms) {
  const d = new Date(ms), dia = `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}`;
  let n = parseInt(localStorage.getItem(FOLIO_KEY) || '0', 10) + 1;
  localStorage.setItem(FOLIO_KEY, String(n));
  return `B513-${dia}-${String(n).padStart(4, '0')}`;
}
function obtenerGPS() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise(ok => navigator.geolocation.getCurrentPosition(
    p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, prec: Math.round(p.coords.accuracy) }),
    () => ok(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }));
}

// ---------- Shop Car: sesión y envío ----------
const SESION_KEY = 'bandera513-sesion';
const BUCKET = 'banderas-fotos';
let sesion = (() => { try { return JSON.parse(localStorage.getItem(SESION_KEY)); } catch { return null; } })();

function guardarSesion(j, usuario) {
  sesion = {
    token: j.access_token, refresh: j.refresh_token, expira: Date.now() + j.expires_in * 1000,
    usuarioId: j.user.id, usuario: usuario ?? sesion?.usuario, nombre: sesion?.nombre,
  };
  localStorage.setItem(SESION_KEY, JSON.stringify(sesion));
}
async function pedirToken(tipo, cuerpo) {
  const r = await fetch(`${SHOPCAR.url}/auth/v1/token?grant_type=${tipo}`, {
    method: 'POST', headers: { apikey: SHOPCAR.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || 'No se pudo iniciar sesión'), { status: r.status });
  return j;
}
// Mismo criterio que el login de Shop Car: sin "@" se arma el correo interno <usuario>@shopcar.local.
async function iniciarSesion(usuario, password) {
  const email = usuario.includes('@') ? usuario.trim() : `${usuario.trim().toLowerCase()}@shopcar.local`;
  guardarSesion(await pedirToken('password', { email, password }), usuario.trim());
  const r = await api(`/rest/v1/usuario_perfil?select=nombre_completo&usuario_id=eq.${sesion.usuarioId}`);
  const perfil = r.ok ? (await r.json())[0] : null;
  sesion.nombre = perfil?.nombre_completo || sesion.usuario;
  localStorage.setItem(SESION_KEY, JSON.stringify(sesion));
  // Los reportes hechos antes de existir el inicio de sesión no tienen dueño: se envían
  // a nombre del primer usuario que entre en este teléfono.
  for (const r of await todos()) {
    if (r.usuarioId) continue;
    Object.assign(r, { remotoId: crypto.randomUUID(), usuarioId: sesion.usuarioId, enviado: { colocacion: false, retiro: false } });
    await guardar(r);
  }
}
// Las localidades salen del catálogo de Shop Car. Se guarda una copia para poder elegir sin señal.
async function cargarLocalidades() {
  if (sesion && navigator.onLine) {
    try {
      const r = await api('/rest/v1/localidades?select=id,nombre&order=nombre');
      if (r.ok) localStorage.setItem(CATALOGO_KEY, JSON.stringify(await r.json()));
    } catch { /* sin señal: se usa la copia guardada */ }
  }
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(CATALOGO_KEY)) || []; } catch { /* sin copia */ }
  const sel = $('#cLocalidad'), actual = sel.value;
  sel.innerHTML = '<option value="">Elige la localidad…</option>' +
    lista.map(l => `<option value="${esc(l.nombre)}" data-id="${l.id}">${esc(l.nombre)}</option>`).join('');
  sel.value = actual;
}
const localidadIdElegida = () => Number($('#cLocalidad').selectedOptions[0]?.dataset.id) || null;

function cerrarSesion() {
  sesion = null;
  localStorage.removeItem(SESION_KEY);
  mostrarLogin();
}
async function token() {
  if (!sesion) throw new Error('Sin sesión');
  if (sesion.expira - 60e3 > Date.now()) return sesion.token;
  try {
    guardarSesion(await pedirToken('refresh_token', { refresh_token: sesion.refresh }));
  } catch (err) {
    // Un refresh rechazado (no un fallo de red) significa que la sesión ya no vale.
    if (err.status >= 400 && err.status < 500) { cerrarSesion(); avisar('Tu sesión expiró. Vuelve a entrar.', 5000); }
    throw err;
  }
  return sesion.token;
}
async function api(ruta, opciones = {}) {
  const t = await token();
  return fetch(SHOPCAR.url + ruta, { ...opciones, headers: { apikey: SHOPCAR.anonKey, Authorization: `Bearer ${t}`, ...opciones.headers } });
}
async function rpc(nombre, args) {
  const r = await api(`/rest/v1/rpc/${nombre}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.message || `Error ${r.status}`);
  return j;
}
async function subirFoto(ruta, blob) {
  const r = await api(`/storage/v1/object/${BUCKET}/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (r.ok) return;
  const j = await r.json().catch(() => ({}));
  // Ya estaba subida (un envío anterior que se cortó a la mitad).
  if (r.status === 409 || String(j.statusCode) === '409' || /duplicate|already exists/i.test(j.message || j.error || '')) return;
  throw new Error(j.message || j.error || `Error ${r.status} al subir la foto`);
}
const gpsCampos = (pre, g) => ({ [`${pre}_lat`]: g?.lat ?? null, [`${pre}_lon`]: g?.lon ?? null, [`${pre}_precision_m`]: g?.prec ?? null });
const pendiente = r => r.usuarioId && (!r.enviado?.colocacion || (r.retiro && !r.enviado?.retiro) || (r.cierre && !r.enviado?.cierre));

async function enviarRegistro(r) {
  if (!r.enviado.colocacion) {
    const ruta = `${r.usuarioId}/${r.remotoId}_colocacion.jpg`;
    await subirFoto(ruta, r.colocacion.foto);
    const viejo = !('via' in r);
    const res = await api('/rest/v1/banderas_azules', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: r.remotoId, folio: r.folio, responsable: colocoDe(r), ficha: r.colocacion.ficha || null,
        empresa: r.empresa || null, localidad: r.localidad || r.ubicacion, localidad_id: r.localidadId ?? null,
        via: viejo ? null : r.via, equipo: viejo ? null : (r.equipo || null),
        via_equipo: viejo ? ((r.localidad && r.ubicacion) || null) : null,
        observaciones: r.obs || null, colocada_at: new Date(r.colocacion.ms).toISOString(),
        ...gpsCampos('colocada', r.colocacion.gps), foto_colocacion: ruta,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (/banderas_una_abierta_por_via/.test(j.message || '')) {
        // En Shop Car ya hay otra abierta en esa vía (de otro teléfono): hay que indicar el motivo.
        r.conflicto = true;
        await guardar(r);
        throw new Error('Ya hay una bandera abierta en esa vía en Shop Car');
      }
      // Otro 409 = ya existía (se había enviado y no llegó la respuesta).
      if (res.status !== 409) throw new Error(j.message || `Error ${res.status}`);
    }
    r.enviado.colocacion = true;
    r.conflicto = false;
    await guardar(r);
  }
  if (r.retiro && !r.enviado.retiro) {
    const ruta = `${sesion.usuarioId}/${r.remotoId}_retiro.jpg`;
    await subirFoto(ruta, r.retiro.foto);
    const res = await api(`/rest/v1/banderas_azules?id=eq.${r.remotoId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        retirada_at: new Date(r.retiro.ms).toISOString(), retirada_responsable: r.retiro.responsable || 'Sin nombre',
        ...gpsCampos('retirada', r.retiro.gps), foto_retiro: ruta,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      // Ya estaba retirada o cerrada sin retiro (otro intento sí llegó, o la cerró alguien más).
      if (!/ya se registró como retirada|ya se cerró sin retiro/.test(j.message || '')) throw new Error(j.message || `Error ${res.status}`);
    }
    r.enviado.retiro = true;
    await guardar(r);
  }
  if (r.cierre && !r.enviado.cierre) {
    try {
      await rpc('cerrar_bandera_sin_retiro', { p_id: r.remotoId, p_motivo: r.cierre.motivo });
    } catch (err) {
      if (!/ya no está abierta/.test(err.message)) throw err;
    }
    r.enviado.cierre = true;
    await guardar(r);
  }
}

let enviando = false;
async function sincronizar(manual = false) {
  if (enviando || !sesion || !SHOPCAR.url) return;
  enviando = true;
  let error = null;
  try {
    // De la más vieja a la más nueva: el cierre de la anterior tiene que llegar antes que la nueva de esa vía.
    const lista = (await todos()).sort((a, b) => a.colocacion.ms - b.colocacion.ms);
    for (const r of lista) {
      if (r.usuarioId !== sesion.usuarioId || !pendiente(r)) continue;
      try { await enviarRegistro(r); } catch (err) { error = err; if (!sesion) break; }
    }
  } finally {
    enviando = false;
  }
  await pintar();
  if (manual) avisar(error ? `No se pudo enviar todo: ${error.message}` : 'Todo está enviado a Shop Car.', 4000);
}
setInterval(sincronizar, 60e3);
window.addEventListener('online', () => sincronizar());

function mostrarLogin() {
  const sinSesion = !sesion;
  $('#vista-login').hidden = !sinSesion;
  document.querySelector('.pestanas').hidden = sinSesion;
  document.querySelector('main').hidden = sinSesion;
  $('#btnSalir').hidden = sinSesion;
  if (sinSesion) {
    $('#estadoEnvio').hidden = true;
    $('#loginError').hidden = true;
    if (!SHOPCAR.url) { $('#loginError').textContent = 'La conexión con Shop Car aún no está configurada.'; $('#loginError').hidden = false; }
  }
}
$('#formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  $('#btnEntrar').disabled = true; $('#loginError').hidden = true;
  try {
    await iniciarSesion($('#lUsuario').value, $('#lPassword').value);
    $('#lPassword').value = '';
    mostrarLogin();
    await cargarLocalidades();
    document.querySelector('[data-vista="activas"]').click();
    avisar(`Bienvenido, ${sesion.nombre}.`);
    await pintar(); sincronizar();
  } catch (err) {
    $('#loginError').textContent = /invalid/i.test(err.message) ? 'Usuario o contraseña incorrectos.' : err.message;
    $('#loginError').hidden = false;
  } finally { $('#btnEntrar').disabled = false; }
});
$('#btnSalir').addEventListener('click', async () => {
  const n = (await todos()).filter(r => r.usuarioId === sesion?.usuarioId && pendiente(r)).length;
  const msj = n
    ? `Tienes ${n} registro(s) sin enviar a Shop Car. Se enviarán cuando vuelvas a entrar con este usuario. ¿Cerrar sesión?`
    : `¿Cerrar la sesión de ${sesion.nombre}?`;
  if (confirm(msj)) cerrarSesion();
});
$('#estadoEnvio').addEventListener('click', () => sincronizar(true));

// ---------- Marca de agua ----------
async function fotoConMarca(archivo, info) {
  const bmp = await createImageBitmap(archivo); // Chrome respeta la orientación EXIF
  const k = Math.min(1, MAX_LADO / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.drawImage(bmp, 0, 0, W, H);
  bmp.close && bmp.close();

  const base = Math.max(14, Math.round(Math.min(W, H) / 30));

  // Texto tenue repetido en diagonal (dificulta recortar o reutilizar la foto)
  c.save();
  c.translate(W / 2, H / 2); c.rotate(-Math.PI / 6);
  c.font = `700 ${base * 1.6}px system-ui, sans-serif`;
  c.fillStyle = 'rgba(255,255,255,0.13)';
  c.textAlign = 'center';
  const texto = `REGLA 5.13 · ${info.folio}`;
  const paso = base * 6, ancho = c.measureText(texto).width + base * 4, diag = Math.hypot(W, H);
  for (let fila = 0, y = -diag / 2; y < diag / 2; fila++, y += paso)
    for (let x = -diag / 2; x < diag / 2 + ancho; x += ancho)
      c.fillText(texto, x + (fila % 2 ? ancho / 2 : 0), y);
  c.restore();

  // Franja inferior con los datos
  const lineas = [
    [`${info.tipo === 'colocacion' ? 'COLOCACIÓN' : 'RETIRO'} DE BANDERA · REGLA 5.13`, true],
    [`Fecha y hora: ${fechaHora(info.ms)}`],
    [`Localidad: ${info.localidad}`],
    ...(info.via ? [[`Vía: ${info.via}`]] : []),
    ...(info.equipo ? [[`Equipo: ${info.equipo}`]] : []),
    [`Colocó: ${info.coloco}`],
  ];
  if (info.tipo === 'retiro') {
    lineas.push([`Retiró: ${info.reporta}`]);
    lineas.push([`Tiempo colocada: ${duracion(info.tiempo)}  (desde ${fechaHora(info.desde)})`, true]);
  } else if (info.reporta !== info.coloco) {
    lineas.push([`Reportó: ${info.reporta}`]);
  }
  lineas.push([info.gps ? `GPS: ${info.gps.lat.toFixed(6)}, ${info.gps.lon.toFixed(6)} ±${info.gps.prec} m` : 'GPS: no disponible']);
  lineas.push([`Folio: ${info.folio}`]);

  const alto = base * 1.45, pad = base * 0.8;
  const franja = lineas.length * alto + pad * 1.6;
  c.fillStyle = 'rgba(8, 18, 40, 0.72)';
  c.fillRect(0, H - franja, W, franja);
  c.fillStyle = info.tipo === 'colocacion' ? '#2f7cf6' : '#e53935';
  c.fillRect(0, H - franja, base * 0.45, franja);
  c.textBaseline = 'top'; c.textAlign = 'left';
  lineas.forEach(([t, negrita], i) => {
    c.font = `${negrita ? 700 : 500} ${negrita ? base * 1.08 : base}px system-ui, sans-serif`;
    c.fillStyle = negrita ? (info.tipo === 'colocacion' ? '#8fb8ff' : '#ff9a97') : '#ffffff';
    c.fillText(t, pad + base * 0.45, H - franja + pad + i * alto, W - pad * 2 - base * 0.45);
  });

  return new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.86));
}

// ---------- Una bandera abierta por vía ----------
// Revisa las banderas abiertas de este teléfono y, si hay señal, las de Shop Car (de cualquier persona).
let revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };

async function revisarVia() {
  const loc = $('#cLocalidad').value.trim(), via = $('#cVia').value.trim();
  const k = `${clave(loc)}|${clave(via)}`;
  if (!loc || !via) { revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] }; pintarBloqueo(); return revisionVia; }
  revisionVia = { clave: k, estado: 'verificando', locales: [], remotas: [] };
  const registrosLocales = await todos();
  const locales = registrosLocales.filter(r => abierta(r) && clave(r.localidad) === clave(loc) && clave(viaDe(r)) === clave(via));
  let remotas = [];
  if (navigator.onLine && sesion) {
    try {
      // Las de este teléfono se juzgan por lo que hay aquí (un cierre puede no haber llegado aún).
      const propias = new Set(registrosLocales.map(r => r.remotoId));
      remotas = (await rpc('banderas_abiertas_en_via', { p_localidad: loc, p_via: via })).filter(b => !propias.has(b.id));
    } catch { /* sin señal: solo cuenta lo de este teléfono; Shop Car lo vuelve a revisar al enviar */ }
  }
  if (revisionVia.clave !== k) return revisionVia; // cambiaron los campos mientras se revisaba
  revisionVia = { clave: k, estado: locales.length || remotas.length ? 'bloqueada' : 'libre', locales, remotas };
  pintarBloqueo();
  return revisionVia;
}
function pintarBloqueo() {
  const b = revisionVia, bloqueada = b.estado === 'bloqueada';
  $('#capBloqueo').hidden = !bloqueada;
  if (!bloqueada) return;
  const lista = [
    ...b.locales.map(r => `${r.folio}, colocada ${fechaHora(r.colocacion.ms)} por ${colocoDe(r)}`),
    ...b.remotas.map(r => `${r.folio}, colocada ${fechaHora(new Date(r.colocada_at).getTime())} por ${r.responsable}`),
  ];
  $('#bloqueoTexto').innerHTML = `⚠ <b>Ya hay una bandera abierta en esta vía.</b> No se puede colocar otra hasta que se retire o se indique por qué no se retiró:<br>${lista.map(esc).join('<br>')}`;
  $('#bloqueoRetirar').innerHTML = b.locales.map(r =>
    `<button type="button" class="btn-retirar" data-retirar="${esc(r.id)}">Retirar ${esc(r.folio)}</button>`).join('');
}
let revisionTimer;
['#cLocalidad', '#cVia'].forEach(s => $(s).addEventListener('input', () => {
  revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };
  clearTimeout(revisionTimer); revisionTimer = setTimeout(revisarVia, 500);
}));

$('#btnCerrarSinRetiro').addEventListener('click', async () => {
  const motivo = $('#bMotivo').value.trim();
  if (!motivo) { avisar('Escribe el motivo por el que no se retiró la bandera.'); $('#bMotivo').focus(); return; }
  if (revisionVia.remotas.length && !navigator.onLine) { avisar('Se necesita señal para cerrar una bandera de otro teléfono.', 4500); return; }
  const btn = $('#btnCerrarSinRetiro'); btn.disabled = true;
  try {
    for (const b of revisionVia.remotas) {
      try { await rpc('cerrar_bandera_sin_retiro', { p_id: b.id, p_motivo: motivo }); }
      catch (err) { if (!/ya no está abierta/.test(err.message)) throw err; }
    }
    for (const r of revisionVia.locales) {
      r.cierre = { ms: Date.now(), motivo, responsable: sesion.nombre };
      r.enviado = { ...r.enviado, cierre: false };
      await guardar(r);
    }
    $('#bMotivo').value = '';
    await revisarVia();
    await pintar();
    sincronizar();
    avisar('Bandera anterior cerrada sin retiro. Ya puedes tomar la foto de la nueva.', 4500);
  } catch (err) {
    avisar('No se pudo cerrar: ' + err.message, 5000);
  } finally { btn.disabled = false; }
});

// ---------- Captura (colocar / retirar) ----------
let captura = null; // { tipo, registro?, blob, ms, gps, folio }

function abrirCaptura(tipo, registro) {
  if ($('#dlgCaptura').open) $('#dlgCaptura').close();
  captura = { tipo, registro };
  $('#formCaptura').reset();
  $('#capVista').hidden = true; $('#capVista').src = '';
  $('#btnGuardar').disabled = true;
  $('#capEstado').textContent = '';
  $('#capBloqueo').hidden = true;
  revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };
  if (tipo === 'colocacion') {
    $('#capTitulo').textContent = 'Colocar bandera';
    $('#capDatos').hidden = false; $('#capResumen').hidden = true;
    ['#cLocalidad', '#cVia', '#cColoco'].forEach(s => $(s).required = true);
    $('#cLocalidad').value = localStorage.getItem(LOCALIDAD_KEY) || ''; // si ya no está en el catálogo, queda sin elegir
    $('#cColoco').value = sesion?.nombre || '';
    $('#lblFoto span').textContent = '📷 Tomar foto de la bandera colocada';
  } else {
    $('#capTitulo').textContent = 'Retirar bandera';
    $('#capDatos').hidden = true; $('#capResumen').hidden = false;
    ['#cLocalidad', '#cVia', '#cColoco'].forEach(s => $(s).required = false);
    $('#capResumen').innerHTML = `<b>${esc(lugar(registro))}</b><br>Colocada: ${fechaHora(registro.colocacion.ms)} por ${esc(colocoDe(registro))}<br>
      Folio: ${esc(registro.folio)}<br>Tiempo colocada: <b id="capTiempo" data-desde="${registro.colocacion.ms}">${duracion(Date.now() - registro.colocacion.ms)}</b>`;
    $('#lblFoto span').textContent = '📷 Tomar foto del retiro';
  }
  $('#dlgCaptura').showModal();
}

// Antes de abrir la cámara para una colocación: datos completos y vía libre. La revisión de la vía
// es asíncrona y la cámara solo abre con un toque directo, así que si aún no está lista se pide
// volver a tocar.
$('#lblFoto').addEventListener('click', e => {
  if (captura?.tipo !== 'colocacion') return;
  const falta = [['#cLocalidad', 'la localidad'], ['#cVia', 'la vía'], ['#cColoco', 'quién colocó la bandera']]
    .find(([s]) => !$(s).value.trim());
  if (falta) { e.preventDefault(); avisar(`Primero indica ${falta[1]}.`); $(falta[0]).focus(); return; }
  const k = `${clave($('#cLocalidad').value)}|${clave($('#cVia').value)}`;
  if (revisionVia.clave !== k || revisionVia.estado === 'verificando' || revisionVia.estado === 'pendiente') {
    e.preventDefault();
    $('#capEstado').textContent = 'Revisando si hay otra bandera abierta en esta vía…';
    revisarVia().then(r => {
      $('#capEstado').textContent = r.estado === 'libre' ? 'Vía libre. Toca de nuevo "Tomar foto".' : '';
    });
    return;
  }
  if (revisionVia.estado === 'bloqueada') { e.preventDefault(); $('#capBloqueo').scrollIntoView({ behavior: 'smooth' }); }
});

$('#cFoto').addEventListener('change', async e => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  const ms = Date.now();
  if (archivo.lastModified && ms - archivo.lastModified > ANTIGUEDAD_MAX_MS) {
    $('#capEstado').textContent = '⚠ Esa foto no es reciente. Toma la foto en este momento con la cámara.';
    return;
  }
  $('#capEstado').textContent = 'Procesando foto y ubicación…';
  $('#btnGuardar').disabled = true;
  try {
    const gps = await obtenerGPS();
    const r = captura.registro;
    const folio = captura.tipo === 'colocacion' ? (captura.folio ||= siguienteFolio(ms)) : r.folio;
    const blob = await fotoConMarca(archivo, {
      tipo: captura.tipo, ms, folio, gps, reporta: sesion?.nombre || 'Sin nombre',
      localidad: captura.tipo === 'colocacion' ? $('#cLocalidad').value.trim() : (r.localidad || r.ubicacion),
      via: captura.tipo === 'colocacion' ? $('#cVia').value.trim() : (r.localidad ? viaDe(r) : ''),
      equipo: captura.tipo === 'colocacion' ? $('#cEquipo').value.trim() : r.equipo,
      coloco: captura.tipo === 'colocacion' ? $('#cColoco').value.trim() : colocoDe(r),
      tiempo: r ? ms - r.colocacion.ms : 0, desde: r ? r.colocacion.ms : 0,
    });
    Object.assign(captura, { blob, ms, gps, folio });
    const v = $('#capVista');
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(blob); v.hidden = false;
    $('#capEstado').textContent = 'Revisa la foto. Si está bien, presiona Guardar.';
    $('#lblFoto span').textContent = '📷 Repetir foto';
    $('#btnGuardar').disabled = false;
  } catch (err) {
    console.error(err);
    $('#capEstado').textContent = 'No se pudo procesar la foto: ' + err.message;
  }
});

$('#btnGuardar').addEventListener('click', async () => {
  if (!captura?.blob) return;
  if (captura.tipo === 'colocacion') {
    // Pudieron colocar otra en la misma vía mientras se tomaba la foto.
    if ((await revisarVia()).estado === 'bloqueada') { $('#capBloqueo').scrollIntoView({ behavior: 'smooth' }); return; }
    await guardar({
      id: captura.folio, folio: captura.folio, localidad: $('#cLocalidad').value.trim(), localidadId: localidadIdElegida(),
      via: $('#cVia').value.trim(),
      equipo: $('#cEquipo').value.trim(), coloco: $('#cColoco').value.trim(), obs: $('#cObs').value.trim(),
      colocacion: { ms: captura.ms, foto: captura.blob, gps: captura.gps, responsable: sesion.nombre },
      retiro: null, cierre: null,
      remotoId: crypto.randomUUID(), usuarioId: sesion.usuarioId, enviado: { colocacion: false, retiro: false, cierre: false },
    });
    localStorage.setItem(LOCALIDAD_KEY, $('#cLocalidad').value.trim());
    avisar('Bandera registrada como colocada. El tiempo empieza a contar.');
  } else {
    const r = captura.registro;
    r.retiro = { ms: captura.ms, foto: captura.blob, gps: captura.gps, responsable: sesion.nombre };
    r.duracionMs = captura.ms - r.colocacion.ms;
    await guardar(r);
    avisar(`Bandera retirada. Tiempo colocada: ${duracion(r.duracionMs)}`, 5000);
  }
  captura = null;
  $('#dlgCaptura').close();
  await pintar();
  sincronizar();
});
$('#btnCancelar').addEventListener('click', () => { captura = null; $('#dlgCaptura').close(); });

// ---------- Vistas ----------
let registros = [];
const urls = new Map(); // id+tipo -> objectURL de la foto
function urlFoto(r, tipo) {
  const k = r.id + tipo;
  if (!urls.has(k)) urls.set(k, URL.createObjectURL(r[tipo].foto));
  return urls.get(k);
}

function etiquetaEnvio(r) {
  if (!r.usuarioId) return '<span class="envio">Solo en este teléfono</span>';
  if (r.conflicto) {
    return `<span class="envio alerta">⚠ En Shop Car ya había otra bandera abierta en esta vía.</span>
      <button class="btn-retirar" data-conflicto="${esc(r.id)}">Indicar motivo y enviar</button>`;
  }
  return pendiente(r) ? '<span class="envio">⏳ Pendiente de enviar a Shop Car</span>' : '<span class="envio ok">✓ Enviado a Shop Car</span>';
}

function tarjetaActiva(r) {
  return `<div class="tarjeta bandera" data-id="${esc(r.id)}">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="cronometro" data-desde="${r.colocacion.ms}">${duracion(Date.now() - r.colocacion.ms)}</div>
    <div class="meta">Colocada ${fechaHora(r.colocacion.ms)} · Colocó: ${esc(colocoDe(r))}
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}</div>
    <div class="fotos"><figure><img src="${urlFoto(r, 'colocacion')}" data-foto="${esc(r.id)}|colocacion" alt="Foto de colocación"><figcaption>Colocación</figcaption></figure></div>
    <button class="btn-retirar" data-retirar="${esc(r.id)}">Retirar bandera</button>
  </div>`;
}
function tarjetaHistorial(r) {
  const fin = r.retiro
    ? `Retirada: ${fechaHora(r.retiro.ms)} · ${esc(r.retiro.responsable || '—')}`
    : `<span class="sin-retiro">Cerrada sin retiro</span>: ${fechaHora(r.cierre.ms)} · Motivo: ${esc(r.cierre.motivo)}`;
  return `<div class="tarjeta">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="meta">
      Colocada: ${fechaHora(r.colocacion.ms)} · Colocó: ${esc(colocoDe(r))}<br>
      ${fin}<br>
      Tiempo colocada: <span class="duracion">${duracion(finDe(r) - r.colocacion.ms)}</span>
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}
    </div>
    <div class="fotos">
      <figure><img src="${urlFoto(r, 'colocacion')}" data-foto="${esc(r.id)}|colocacion" alt="Foto de colocación"><figcaption>Colocación</figcaption></figure>
      ${r.retiro ? `<figure><img src="${urlFoto(r, 'retiro')}" data-foto="${esc(r.id)}|retiro" alt="Foto de retiro"><figcaption>Retiro</figcaption></figure>` : ''}
    </div>
    ${pendiente(r) ? '' : `<button class="borrar" data-borrar="${esc(r.id)}">Quitar de este teléfono</button>`}
  </div>`;
}

function filtrados() {
  const d = $('#fDesde').value, h = $('#fHasta').value;
  const ini = d ? new Date(d + 'T00:00').getTime() : -Infinity, fin = h ? new Date(h + 'T23:59:59.999').getTime() : Infinity;
  return registros.filter(r => !abierta(r) && r.colocacion.ms >= ini && r.colocacion.ms <= fin)
    .sort((a, b) => finDe(b) - finDe(a));
}

async function pintar() {
  registros = await todos();
  const activas = registros.filter(abierta).sort((a, b) => a.colocacion.ms - b.colocacion.ms);
  $('#numActivas').textContent = activas.length;
  $('#listaActivas').innerHTML = activas.length ? activas.map(tarjetaActiva).join('')
    : '<p class="vacio">No hay banderas colocadas en este momento.</p>';

  const hist = filtrados();
  const tiempos = hist.map(r => finDe(r) - r.colocacion.ms);
  $('#resumen').innerHTML = `<div><b>${hist.length}</b><span>Reportes</span></div>
    <div><b>${hist.length ? duracion(tiempos.reduce((s, t) => s + t, 0) / hist.length) : '—'}</b><span>Promedio</span></div>
    <div><b>${hist.length ? duracion(Math.max(...tiempos)) : '—'}</b><span>Máximo</span></div>`;
  $('#listaHistorial').innerHTML = hist.length ? hist.map(tarjetaHistorial).join('')
    : '<p class="vacio">Aún no hay banderas retiradas en este periodo.</p>';

  const opciones = valores => [...new Set(valores.filter(Boolean))].slice(0, 30).map(u => `<option value="${esc(u)}">`).join('');
  $('#viasUsadas').innerHTML = opciones(registros.map(r => r.via));
  $('#personasUsadas').innerHTML = opciones([sesion?.nombre, ...registros.map(r => r.coloco)]);

  if (sesion) {
    const pendientes = registros.filter(r => r.usuarioId === sesion.usuarioId && pendiente(r)).length;
    const e = $('#estadoEnvio');
    e.hidden = false;
    e.classList.toggle('ok', !pendientes);
    e.textContent = pendientes
      ? `⏳ ${pendientes} registro(s) pendientes de enviar a Shop Car${navigator.onLine ? '' : ' (sin conexión)'} · toca para enviar`
      : `✓ ${sesion.nombre} · todo enviado a Shop Car`;
  }
  tic();
}

// Cronómetros en vivo
function tic() {
  const ahora = Date.now();
  document.querySelectorAll('.cronometro[data-desde]').forEach(el => { el.textContent = duracion(ahora - Number(el.dataset.desde)); });
  const ct = $('#capTiempo');
  if (ct) ct.textContent = duracion(ahora - Number(ct.dataset.desde));
}
setInterval(tic, 1000);

// ---------- Eventos de listas ----------
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.retirar) abrirCaptura('retiro', registros.find(r => r.id === t.dataset.retirar));
  else if (t.dataset.foto) verFoto(...t.dataset.foto.split('|'));
  else if (t.dataset.conflicto) resolverConflicto(registros.find(r => r.id === t.dataset.conflicto));
  else if (t.dataset.borrar) {
    const r = registros.find(x => x.id === t.dataset.borrar);
    const aviso = r.usuarioId ? ' En Shop Car el registro se conserva.' : ' No se puede deshacer.';
    if (confirm(`¿Quitar de este teléfono el registro ${r.folio} (${lugar(r)}) y sus fotos?${aviso}`)) {
      await borrar(r.id);
      ['colocacion', 'retiro'].forEach(k => { URL.revokeObjectURL(urls.get(r.id + k)); urls.delete(r.id + k); });
      pintar();
    }
  }
});
$('#btnColocar').addEventListener('click', () => abrirCaptura('colocacion'));

// Una colocación hecha sin señal chocó en Shop Car con otra abierta en la misma vía.
async function resolverConflicto(r) {
  const motivo = prompt('En Shop Car ya había otra bandera abierta en esta vía. ¿Por qué no se retiró?');
  if (!motivo?.trim()) return;
  try {
    const abiertas = (await rpc('banderas_abiertas_en_via', { p_localidad: r.localidad, p_via: viaDe(r) })).filter(b => b.id !== r.remotoId);
    for (const b of abiertas) {
      try { await rpc('cerrar_bandera_sin_retiro', { p_id: b.id, p_motivo: motivo.trim() }); }
      catch (err) { if (!/ya no está abierta/.test(err.message)) throw err; }
    }
    r.conflicto = false;
    await guardar(r);
    await sincronizar(true);
  } catch (err) { avisar('No se pudo: ' + err.message, 5000); }
}

let fotoActual = null;
function verFoto(id, tipo) {
  const r = registros.find(x => x.id === id);
  fotoActual = { blob: r[tipo].foto, nombre: `${r.folio}_${tipo}.jpg` };
  $('#visorImg').src = urlFoto(r, tipo);
  $('#btnCompartir').hidden = !navigator.canShare;
  $('#dlgFoto').showModal();
}
$('#btnCerrarFoto').addEventListener('click', () => $('#dlgFoto').close());
$('#btnDescargar').addEventListener('click', () => descargar(fotoActual.blob, fotoActual.nombre));
$('#btnCompartir').addEventListener('click', async () => {
  const f = new File([fotoActual.blob], fotoActual.nombre, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: 'Bandera Regla 5.13' }); } catch { /* cancelado */ }
  } else avisar('Este dispositivo no permite compartir archivos; usa Descargar.');
});
function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- Pestañas ----------
document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.pestanas button').forEach(x => x.classList.toggle('activa', x === b));
  document.querySelectorAll('.vista').forEach(v => v.hidden = v.id !== 'vista-' + b.dataset.vista);
}));
$('#fDesde').addEventListener('change', pintar);
$('#fHasta').addEventListener('change', pintar);

// ---------- Exportar CSV ----------
$('#btnCsv').addEventListener('click', () => {
  const hist = filtrados();
  if (!hist.length) return avisar('No hay registros en el periodo.');
  const cols = ['Folio', 'Localidad', 'Vía', 'Equipo', 'Colocó', 'Fecha colocación', 'GPS colocación',
    'Estado', 'Fecha retiro / cierre', 'Retiró', 'GPS retiro', 'Motivo sin retiro', 'Tiempo colocada (hh:mm:ss)', 'Minutos', 'Observaciones'];
  const gps = g => g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : '';
  const filas = hist.map(r => {
    const ms = finDe(r) - r.colocacion.ms;
    return [r.folio, r.localidad || '', viaDe(r), r.equipo, colocoDe(r), fechaHora(r.colocacion.ms), gps(r.colocacion.gps),
      r.retiro ? 'Retirada' : 'Sin retiro', fechaHora(finDe(r)), r.retiro?.responsable, gps(r.retiro?.gps), r.cierre?.motivo,
      duracion(ms), (ms / 60000).toFixed(1), r.obs];
  });
  const csv = [cols, ...filas].map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const d = new Date();
  descargar(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `banderas_513_${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}.csv`);
});

// ---------- Instalación ----------
let promptInstalar;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptInstalar = e; $('#btnInstalar').hidden = false; });
$('#btnInstalar').addEventListener('click', async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt(); await promptInstalar.userChoice;
  promptInstalar = null; $('#btnInstalar').hidden = true;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

// ---------- Inicio ----------
(async () => {
  await abrirDB();
  navigator.storage?.persist?.();
  localStorage.removeItem('bandera513-ajustes'); // la pantalla de Ajustes ya no existe
  mostrarLogin();
  await cargarLocalidades();
  await pintar();
  sincronizar();
})();
