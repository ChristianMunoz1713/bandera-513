// Bandera de Seguridad · Regla 5.13
// Registra colocación y retiro de la bandera con foto tomada en el momento (marca de agua incrustada)
// y cuenta el tiempo que la bandera permanece colocada. Cada registro se guarda primero en este
// dispositivo (IndexedDB) y luego se envía a Shop Car a nombre del usuario que inició sesión; si no
// hay señal queda pendiente y se reintenta solo.

const $ = s => document.querySelector(s);
const AJUSTES_KEY = 'bandera513-ajustes';
const FOLIO_KEY = 'bandera513-folio';
const LOCALIDAD_KEY = 'bandera513-localidad'; // última localidad usada, para no reescribirla
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
const ajustes = () => {
  try { return Object.assign({ responsable: '', ficha: '', empresa: '', gps: true, alertaHoras: 0 }, JSON.parse(localStorage.getItem(AJUSTES_KEY))); }
  catch { return { responsable: '', ficha: '', empresa: '', gps: true, alertaHoras: 0 }; }
};
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
// Título del lugar: localidad y, si se capturó, la vía o equipo (los registros antiguos solo tienen ubicación)
const lugar = r => [r.localidad, r.ubicacion].filter(Boolean).join(' · ');
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
  if (!ajustes().gps || !navigator.geolocation) return Promise.resolve(null);
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
  // El nombre de Shop Car es el que va en la marca de agua.
  const a = ajustes();
  localStorage.setItem(AJUSTES_KEY, JSON.stringify({ ...a, responsable: sesion.nombre }));
}
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
async function subirFoto(ruta, blob) {
  const r = await api(`/storage/v1/object/${BUCKET}/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (r.ok) return;
  const j = await r.json().catch(() => ({}));
  // Ya estaba subida (un envío anterior que se cortó a la mitad).
  if (r.status === 409 || String(j.statusCode) === '409' || /duplicate|already exists/i.test(j.message || j.error || '')) return;
  throw new Error(j.message || j.error || `Error ${r.status} al subir la foto`);
}
const gpsCampos = (pre, g) => ({ [`${pre}_lat`]: g?.lat ?? null, [`${pre}_lon`]: g?.lon ?? null, [`${pre}_precision_m`]: g?.prec ?? null });
const pendiente = r => r.usuarioId && (!r.enviado?.colocacion || (r.retiro && !r.enviado?.retiro));

async function enviarRegistro(r) {
  const carpeta = r.usuarioId;
  if (!r.enviado.colocacion) {
    const ruta = `${carpeta}/${r.remotoId}_colocacion.jpg`;
    await subirFoto(ruta, r.colocacion.foto);
    const res = await api('/rest/v1/banderas_azules', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: r.remotoId, folio: r.folio, responsable: r.colocacion.responsable || 'Sin nombre', ficha: r.colocacion.ficha || null,
        empresa: r.empresa || null, localidad: r.localidad || r.ubicacion, via_equipo: (r.localidad && r.ubicacion) || null,
        observaciones: r.obs || null, colocada_at: new Date(r.colocacion.ms).toISOString(),
        ...gpsCampos('colocada', r.colocacion.gps), foto_colocacion: ruta,
      }),
    });
    // 409 = ya existía (se había enviado y no llegó la respuesta).
    if (!res.ok && res.status !== 409) throw new Error((await res.json().catch(() => ({}))).message || `Error ${res.status}`);
    r.enviado.colocacion = true;
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
      // Ya estaba registrada como retirada (otro intento sí llegó, o la retiró un supervisor).
      if (!/ya se registró como retirada/.test(j.message || '')) throw new Error(j.message || `Error ${res.status}`);
    }
    r.enviado.retiro = true;
    await guardar(r);
  }
}

let enviando = false;
async function sincronizar(manual = false) {
  if (enviando || !sesion || !SHOPCAR.url) return;
  enviando = true;
  let error = null;
  try {
    for (const r of await todos()) {
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
    mostrarLogin(); cargarAjustes();
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
  if (n && !confirm(`Tienes ${n} registro(s) sin enviar a Shop Car. Se enviarán cuando vuelvas a entrar con este usuario. ¿Cerrar sesión?`)) return;
  cerrarSesion();
});
$('#btnEnviar').addEventListener('click', () => sincronizar(true));

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
    ...(info.ubicacion ? [[`Vía / equipo: ${info.ubicacion}`]] : []),
    [`Responsable: ${info.responsable}${info.ficha ? ' · Ficha ' + info.ficha : ''}`],
  ];
  if (info.empresa) lineas.push([info.empresa]);
  if (info.tipo === 'retiro') lineas.push([`Tiempo colocada: ${duracion(info.tiempo)}  (desde ${fechaHora(info.desde)})`, true]);
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

// ---------- Captura (colocar / retirar) ----------
let captura = null; // { tipo, registro?, blob, ms, gps }

function abrirCaptura(tipo, registro) {
  captura = { tipo, registro };
  $('#formCaptura').reset();
  $('#capVista').hidden = true; $('#capVista').src = '';
  $('#btnGuardar').disabled = true;
  $('#capEstado').textContent = '';
  const a = ajustes();
  if (tipo === 'colocacion') {
    $('#capTitulo').textContent = 'Colocar bandera';
    $('#capDatos').hidden = false; $('#capResumen').hidden = true;
    $('#cLocalidad').required = true;
    $('#cLocalidad').value = localStorage.getItem(LOCALIDAD_KEY) || '';
    $('#lblFoto span').textContent = '📷 Tomar foto de la bandera colocada';
  } else {
    $('#capTitulo').textContent = 'Retirar bandera';
    $('#capDatos').hidden = true; $('#capResumen').hidden = false;
    $('#cLocalidad').required = false;
    $('#capResumen').innerHTML = `<b>${esc(lugar(registro))}</b><br>Colocada: ${fechaHora(registro.colocacion.ms)}<br>
      Folio: ${esc(registro.folio)}<br>Tiempo colocada: <b id="capTiempo" data-desde="${registro.colocacion.ms}">${duracion(Date.now() - registro.colocacion.ms)}</b>`;
    $('#lblFoto span').textContent = '📷 Tomar foto del retiro';
  }
  if (!a.responsable) $('#capEstado').textContent = 'Tip: captura tu nombre en Ajustes para que aparezca en la marca de agua.';
  $('#dlgCaptura').showModal();
}

$('#cFoto').addEventListener('change', async e => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  if (captura.tipo === 'colocacion' && !$('#cLocalidad').value.trim()) {
    avisar('Primero indica la localidad donde se coloca la bandera.'); $('#cLocalidad').focus(); return;
  }
  const ms = Date.now();
  if (archivo.lastModified && ms - archivo.lastModified > ANTIGUEDAD_MAX_MS) {
    $('#capEstado').textContent = '⚠ Esa foto no es reciente. Toma la foto en este momento con la cámara.';
    return;
  }
  $('#capEstado').textContent = 'Procesando foto y ubicación…';
  $('#btnGuardar').disabled = true;
  try {
    const a = ajustes();
    const gps = await obtenerGPS();
    const r = captura.registro;
    const folio = captura.tipo === 'colocacion' ? (captura.folio ||= siguienteFolio(ms)) : r.folio;
    const blob = await fotoConMarca(archivo, {
      tipo: captura.tipo, ms, folio, gps,
      localidad: captura.tipo === 'colocacion' ? $('#cLocalidad').value.trim() : (r.localidad || r.ubicacion),
      ubicacion: captura.tipo === 'colocacion' ? $('#cUbicacion').value.trim() : (r.localidad ? r.ubicacion : ''),
      responsable: a.responsable || 'Sin nombre', ficha: a.ficha, empresa: a.empresa,
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
  const a = ajustes();
  const evento = { ms: captura.ms, foto: captura.blob, gps: captura.gps, responsable: a.responsable, ficha: a.ficha };
  if (captura.tipo === 'colocacion') {
    await guardar({
      id: captura.folio, folio: captura.folio, localidad: $('#cLocalidad').value.trim(), ubicacion: $('#cUbicacion').value.trim(),
      obs: $('#cObs').value.trim(), empresa: a.empresa, colocacion: evento, retiro: null,
      remotoId: crypto.randomUUID(), usuarioId: sesion.usuarioId, enviado: { colocacion: false, retiro: false },
    });
    localStorage.setItem(LOCALIDAD_KEY, $('#cLocalidad').value.trim());
    avisar('Bandera registrada como colocada. El tiempo empieza a contar.');
  } else {
    const r = captura.registro;
    r.retiro = evento;
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
  return pendiente(r) ? '<span class="envio">⏳ Pendiente de enviar a Shop Car</span>' : '<span class="envio ok">✓ Enviado a Shop Car</span>';
}

function tarjetaActiva(r) {
  return `<div class="tarjeta bandera" data-id="${esc(r.id)}">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="cronometro" data-desde="${r.colocacion.ms}">${duracion(Date.now() - r.colocacion.ms)}</div>
    <div class="meta">Colocada ${fechaHora(r.colocacion.ms)} · ${esc(r.colocacion.responsable || 'Sin nombre')}
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}</div>
    <div class="fotos"><figure><img src="${urlFoto(r, 'colocacion')}" data-foto="${esc(r.id)}|colocacion" alt="Foto de colocación"><figcaption>Colocación</figcaption></figure></div>
    <button class="btn-retirar" data-retirar="${esc(r.id)}">Retirar bandera</button>
  </div>`;
}
function tarjetaHistorial(r) {
  return `<div class="tarjeta">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="meta">
      Colocada: ${fechaHora(r.colocacion.ms)} · ${esc(r.colocacion.responsable || '—')}<br>
      Retirada: ${fechaHora(r.retiro.ms)} · ${esc(r.retiro.responsable || '—')}<br>
      Tiempo colocada: <span class="duracion">${duracion(r.duracionMs)}</span>
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}
    </div>
    <div class="fotos">
      <figure><img src="${urlFoto(r, 'colocacion')}" data-foto="${esc(r.id)}|colocacion" alt="Foto de colocación"><figcaption>Colocación</figcaption></figure>
      <figure><img src="${urlFoto(r, 'retiro')}" data-foto="${esc(r.id)}|retiro" alt="Foto de retiro"><figcaption>Retiro</figcaption></figure>
    </div>
    ${pendiente(r) ? '' : `<button class="borrar" data-borrar="${esc(r.id)}">Quitar de este teléfono</button>`}
  </div>`;
}

function filtrados() {
  const d = $('#fDesde').value, h = $('#fHasta').value;
  const ini = d ? new Date(d + 'T00:00').getTime() : -Infinity, fin = h ? new Date(h + 'T23:59:59.999').getTime() : Infinity;
  return registros.filter(r => r.retiro && r.colocacion.ms >= ini && r.colocacion.ms <= fin)
    .sort((a, b) => b.retiro.ms - a.retiro.ms);
}

async function pintar() {
  registros = await todos();
  const activas = registros.filter(r => !r.retiro).sort((a, b) => a.colocacion.ms - b.colocacion.ms);
  $('#numActivas').textContent = activas.length;
  $('#listaActivas').innerHTML = activas.length ? activas.map(tarjetaActiva).join('')
    : '<p class="vacio">No hay banderas colocadas en este momento.</p>';

  const hist = filtrados();
  const total = hist.reduce((s, r) => s + r.duracionMs, 0);
  $('#resumen').innerHTML = `<div><b>${hist.length}</b><span>Reportes</span></div>
    <div><b>${hist.length ? duracion(total / hist.length) : '—'}</b><span>Promedio</span></div>
    <div><b>${hist.length ? duracion(Math.max(...hist.map(r => r.duracionMs))) : '—'}</b><span>Máximo</span></div>`;
  $('#listaHistorial').innerHTML = hist.length ? hist.map(tarjetaHistorial).join('')
    : '<p class="vacio">Aún no hay banderas retiradas en este periodo.</p>';

  const opciones = campo => [...new Set(registros.map(r => r[campo]).filter(Boolean))].slice(0, 30)
    .map(u => `<option value="${esc(u)}">`).join('');
  $('#localidadesUsadas').innerHTML = opciones('localidad');
  $('#ubicacionesUsadas').innerHTML = opciones('ubicacion');

  if (sesion) {
    const pendientes = registros.filter(r => r.usuarioId === sesion.usuarioId && pendiente(r)).length;
    const e = $('#estadoEnvio');
    e.hidden = false;
    e.classList.toggle('ok', !pendientes);
    e.textContent = pendientes
      ? `⏳ ${pendientes} registro(s) pendientes de enviar a Shop Car${navigator.onLine ? '' : ' (sin conexión)'}`
      : `✓ ${sesion.nombre} · todo enviado a Shop Car`;
    $('#infoSesion').textContent = `${sesion.nombre} (${sesion.usuario}) · ${pendientes} pendiente(s) de enviar.`;
  }
  tic();
}

// Cronómetros en vivo
const avisadas = new Set();
function tic() {
  const ahora = Date.now(), lim = (parseFloat(ajustes().alertaHoras) || 0) * 3600e3;
  document.querySelectorAll('.cronometro[data-desde]').forEach(el => {
    const t = ahora - Number(el.dataset.desde);
    el.textContent = duracion(t);
    const tarjeta = el.closest('.bandera');
    const pasada = lim > 0 && t >= lim;
    tarjeta.classList.toggle('alerta', pasada);
    if (pasada && !avisadas.has(tarjeta.dataset.id)) {
      avisadas.add(tarjeta.dataset.id);
      avisar(`⚠ La bandera en "${tarjeta.querySelector('h3').textContent}" lleva más de ${ajustes().alertaHoras} h colocada.`, 6000);
      navigator.vibrate && navigator.vibrate([300, 150, 300]);
    }
  });
  const ct = $('#capTiempo');
  if (ct) ct.textContent = duracion(ahora - Number(ct.dataset.desde));
}
setInterval(tic, 1000);

// ---------- Eventos de listas ----------
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.retirar) abrirCaptura('retiro', registros.find(r => r.id === t.dataset.retirar));
  else if (t.dataset.foto) verFoto(...t.dataset.foto.split('|'));
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
  if (b.dataset.vista === 'ajustes') mostrarEspacio();
}));
$('#fDesde').addEventListener('change', pintar);
$('#fHasta').addEventListener('change', pintar);

// ---------- Exportar CSV ----------
$('#btnCsv').addEventListener('click', () => {
  const hist = filtrados();
  if (!hist.length) return avisar('No hay registros en el periodo.');
  const cols = ['Folio', 'Localidad', 'Vía / equipo', 'Fecha colocación', 'Responsable colocación', 'GPS colocación',
    'Fecha retiro', 'Responsable retiro', 'GPS retiro', 'Tiempo colocada (hh:mm:ss)', 'Minutos', 'Observaciones'];
  const gps = g => g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : '';
  const filas = hist.map(r => [r.folio, r.localidad || '', r.ubicacion, fechaHora(r.colocacion.ms), r.colocacion.responsable, gps(r.colocacion.gps),
    fechaHora(r.retiro.ms), r.retiro.responsable, gps(r.retiro.gps), duracion(r.duracionMs), (r.duracionMs / 60000).toFixed(1), r.obs]);
  const csv = [cols, ...filas].map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const d = new Date();
  descargar(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `banderas_513_${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}.csv`);
});

// ---------- Ajustes ----------
function cargarAjustes() {
  const a = ajustes();
  $('#aResponsable').value = a.responsable; $('#aFicha').value = a.ficha; $('#aEmpresa').value = a.empresa;
  $('#aGps').checked = a.gps; $('#aAlerta').value = a.alertaHoras || '';
}
$('#formAjustes').addEventListener('submit', e => {
  e.preventDefault();
  localStorage.setItem(AJUSTES_KEY, JSON.stringify({
    responsable: $('#aResponsable').value.trim(), ficha: $('#aFicha').value.trim(), empresa: $('#aEmpresa').value.trim(),
    gps: $('#aGps').checked, alertaHoras: parseFloat($('#aAlerta').value) || 0,
  }));
  avisadas.clear();
  avisar('Ajustes guardados.');
});
async function mostrarEspacio() {
  if (!navigator.storage?.estimate) return;
  const { usage } = await navigator.storage.estimate();
  $('#espacio').textContent = `Espacio usado: ${(usage / 1048576).toFixed(1)} MB · ${registros.length} registros.`;
}

// Respaldo: fotos en base64 dentro de un JSON
const aBase64 = b => new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
const deBase64 = async s => (await fetch(s)).blob();
$('#btnRespaldo').addEventListener('click', async () => {
  avisar('Preparando respaldo…');
  const datos = await Promise.all(registros.map(async r => {
    const c = structuredClone({ ...r, colocacion: { ...r.colocacion, foto: null }, retiro: r.retiro && { ...r.retiro, foto: null } });
    c.colocacion.foto = await aBase64(r.colocacion.foto);
    if (r.retiro) c.retiro.foto = await aBase64(r.retiro.foto);
    return c;
  }));
  const d = new Date();
  descargar(new Blob([JSON.stringify({ app: 'bandera513', version: 1, folio: localStorage.getItem(FOLIO_KEY), registros: datos })], { type: 'application/json' }),
    `respaldo_bandera513_${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}.json`);
});
$('#inRestaurar').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'bandera513') throw new Error('El archivo no es un respaldo de esta app.');
    for (const r of j.registros) {
      r.colocacion.foto = await deBase64(r.colocacion.foto);
      if (r.retiro) r.retiro.foto = await deBase64(r.retiro.foto);
      await guardar(r);
    }
    if (parseInt(j.folio || 0, 10) > parseInt(localStorage.getItem(FOLIO_KEY) || 0, 10)) localStorage.setItem(FOLIO_KEY, j.folio);
    avisar(`Se restauraron ${j.registros.length} registros.`);
    pintar();
  } catch (err) { avisar('No se pudo restaurar: ' + err.message, 5000); }
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
  cargarAjustes();
  mostrarLogin();
  await pintar();
  sincronizar();
})();
