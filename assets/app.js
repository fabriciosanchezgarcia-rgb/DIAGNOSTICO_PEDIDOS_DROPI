/* =====================================================================
 * Dropi Ops Analyzer — reconstrucción operativa
 * Todo el procesamiento ocurre en el navegador. El archivo no se persiste.
 * ===================================================================== */

"use strict";

/* --------------------------------------------------------------------
 * 1. Configuración: alias de columnas y agrupación de estados
 * ------------------------------------------------------------------ */

// Normaliza texto: mayúsculas, sin acentos, sin dobles espacios.
function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

// Cada campo canónico -> lista de posibles encabezados del export de Dropi.
const COLUMN_ALIASES = {
  orden:         ["ID", "ORDEN", "ID ORDEN", "NUMERO ORDEN", "N ORDEN", "ORDER ID", "ID DE LA ORDEN"],
  estado:        ["ESTATUS", "ESTADO", "ESTADO DEL ENVIO", "ESTADO ENVIO", "STATUS", "ESTADO DE LA ORDEN"],
  transportadora:["TRANSPORTADORA", "COURIER", "OPERADOR LOGISTICO", "CARRIER"],
  tracking:      ["GUIA", "NUMERO GUIA", "NUMERO DE GUIA", "TRACKING", "N GUIA", "GUIA DE ENVIO"],
  ciudad:        ["CIUDAD", "CIUDAD DESTINO", "CIUDAD DE DESTINO", "CIUDAD ENVIO", "MUNICIPIO"],
  departamento:  ["DEPARTAMENTO", "DEPTO", "DEPARTAMENTO DESTINO", "ESTADO/PROVINCIA"],
  recaudo:       ["TOTAL DE LA ORDEN", "VALOR RECAUDO", "RECAUDO", "VALOR DE RECAUDO", "TOTAL ORDEN",
                  "PRECIO", "MONTO RECAUDO", "COD", "VALOR A COBRAR", "TOTAL"],
  flete:         ["PRECIO FLETE", "FLETE", "COSTO FLETE", "VALOR FLETE", "PRECIO DEL FLETE", "COSTO DE ENVIO"],
  fecha:         ["FECHA", "FECHA CREACION", "FECHA DE CREACION", "FECHA DE LA ORDEN", "CREADO", "FECHA REGISTRO"],
  fechaEntrega:  ["FECHA ENTREGA", "FECHA DE ENTREGA", "ENTREGADO EL", "FECHA ENTREGADO"],
  diasTransito:  ["DIAS TRANSITO", "DIAS DE TRANSITO", "DIAS EN TRANSITO", "DIAS", "TIEMPO TRANSITO"],
};

// Agrupación lógica de estados. Cualquier estado NO listado aquí -> "transito".
const GROUP_BY_STATE = {
  entregado:  ["ENTREGADO", "ENTREGADA"],
  cancelado:  ["CANCELADO", "CANCELADA", "DEVOLUCION", "DEVUELTO", "RECHAZADO", "ANULADO", "DEVOLUCION AL ORIGEN"],
  extraviado: ["EXTRAVIADO", "EXTRAVIO", "EXTRAVIADA", "PERDIDO", "SINIESTRO", "SINIESTRADO"],
  novedad:    ["NOVEDAD", "RECLAME EN OFICINA", "EN ESPERA DE RX", "EN ESPERA", "PENDIENTE DE NOVEDAD"],
};

// Umbrales de negocio (derivados por ingeniería inversa de la app original).
const TH = {
  riesgoEstable: 30, riesgoAlto: 50,          // % pendiente sobre recaudo potencial
  cumplSaludable: 70, cumplRiesgo: 60,        // % de cumplimiento de entrega
  fugaBajo: 8, fugaAlto: 15,                  // % de fuga (cancelado + extraviado)
  fletePresionOk: 18, fletePresionAlto: 25,   // % flete promedio sobre ticket
  cancelWarning: 8, cancelCritical: 15,       // % de cancelación
  fleteEstadoAnomalo: 1.8,                    // factor sobre flete promedio (180%)
  transitoDeterioro: 4,                       // días promedio de tránsito para alerta
  topRiskRows: 60,                            // filas en la tabla de riesgo
};

// Paleta para estados (donut / barras).
const STATE_COLORS = [
  "#f5822e", "#e8622a", "#fbbf24", "#f87171", "#60a5fa", "#a78bfa",
  "#34d399", "#f5a15e", "#f59e0b", "#38bdf8", "#fb7185", "#818cf8",
  "#c084fc", "#4ade80", "#facc15", "#22d3ee", "#fca5a5",
];

/* --------------------------------------------------------------------
 * 2. Utilidades de parseo
 * ------------------------------------------------------------------ */

// Convierte un valor de celda a número (soporta formato COL "$ 93.900" / "1.234,56").
function toNumber(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (s === "" || s === "-") return 0;
  const hasDot = s.includes("."), hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // El último separador es el decimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // Coma sola: decimal si hay <=2 dígitos después; si no, es separador de miles.
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (hasDot) {
    // Punto solo: separador de miles si agrupa de a 3 (formato COL).
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Convierte celda a fecha (Date de SheetJS, serial Excel o string).
function toDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number") {
    // Serial de Excel -> epoch (base 1899-12-30).
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);          // YYYY-MM-DD
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);              // DD/MM/YYYY
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function dateKey(d) {
  if (!d) return null;
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Formateadores COL.
const fmtMoney = (n) => "$ " + new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmtInt = (n) => new Intl.NumberFormat("es-CO").format(Math.round(n || 0));
const fmtPct = (n) => (isFinite(n) ? n : 0).toFixed(1) + "%";

/* --------------------------------------------------------------------
 * 3. Mapeo de encabezados -> índice de columna
 * ------------------------------------------------------------------ */

function buildHeaderMap(headerRow) {
  const normalized = headerRow.map(norm);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    let idx = -1;
    // 1) coincidencia exacta
    for (const a of aliases) { idx = normalized.indexOf(norm(a)); if (idx !== -1) break; }
    // 2) coincidencia parcial (encabezado contiene el alias)
    if (idx === -1) {
      for (const a of aliases) {
        const na = norm(a);
        idx = normalized.findIndex((h) => h.includes(na));
        if (idx !== -1) break;
      }
    }
    map[field] = idx;
  }
  return map;
}

function groupOfState(estado) {
  const e = norm(estado);
  for (const [group, states] of Object.entries(GROUP_BY_STATE)) {
    if (states.some((s) => e === s || e.includes(s))) return group;
  }
  return "transito";
}

/* --------------------------------------------------------------------
 * 4. Normalización del reporte a filas canónicas
 * ------------------------------------------------------------------ */

function normalizeRows(matrix) {
  // Busca la fila de encabezado: la primera con >=3 columnas reconocidas.
  let headerIdx = 0, best = -1;
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const m = buildHeaderMap(matrix[i]);
    const score = Object.values(m).filter((x) => x !== -1).length;
    if (score > best) { best = score; headerIdx = i; }
  }
  const map = buildHeaderMap(matrix[headerIdx]);
  if (best < 2) throw new Error("No se reconocieron columnas de Dropi (estado, recaudo, etc.). Verifica el archivo.");

  const cell = (row, field) => (map[field] === -1 ? "" : row[map[field]]);
  const rows = [];
  const today = new Date();

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const raw = matrix[i];
    if (!raw || raw.every((c) => c == null || c === "")) continue;

    const estado = String(cell(raw, "estado") || "").trim();
    if (!estado && map.estado !== -1) continue; // fila vacía en estado -> ignorar

    const fecha = toDate(cell(raw, "fecha"));
    const fechaEntrega = toDate(cell(raw, "fechaEntrega"));
    let dias = map.diasTransito !== -1 ? toNumber(cell(raw, "diasTransito")) : NaN;
    if (!isFinite(dias) || dias === 0) {
      if (fecha && fechaEntrega) dias = Math.max(0, Math.round((fechaEntrega - fecha) / 86400000));
      else if (fecha) dias = Math.max(0, Math.round((today - fecha) / 86400000));
      else dias = 0;
    }

    rows.push({
      orden: String(cell(raw, "orden") || "").trim(),
      estado,
      grupo: groupOfState(estado),
      transportadora: String(cell(raw, "transportadora") || "—").trim() || "—",
      tracking: String(cell(raw, "tracking") || "").trim(),
      ciudad: (String(cell(raw, "ciudad") || "—").trim() || "—").toUpperCase(),
      departamento: (String(cell(raw, "departamento") || "").trim()).toUpperCase(),
      recaudo: toNumber(cell(raw, "recaudo")),
      flete: toNumber(cell(raw, "flete")),
      fecha,
      dias,
    });
  }
  if (!rows.length) throw new Error("El archivo no contiene filas de órdenes.");
  return rows;
}

/* --------------------------------------------------------------------
 * 5. Cálculo de métricas
 * ------------------------------------------------------------------ */

function computeMetrics(rows) {
  const total = rows.length;
  const by = { entregado: 0, transito: 0, novedad: 0, cancelado: 0, extraviado: 0 };
  let recaudoPotencial = 0, recaudoCobrado = 0;
  let fleteSum = 0, fleteCount = 0, recaudoCount = 0;
  let diasSum = 0, diasCount = 0;

  const stateCount = {};        // conteo por estado
  const stateMoney = {};        // COD por estado
  const cityFuga = {};          // conteo de fuga por ciudad
  const carrierPending = {};    // recaudo pendiente por transportadora

  for (const r of rows) {
    by[r.grupo] = (by[r.grupo] || 0) + 1;
    recaudoPotencial += r.recaudo;
    if (r.recaudo > 0) recaudoCount++;
    if (r.grupo === "entregado") recaudoCobrado += r.recaudo;
    else carrierPending[r.transportadora] = (carrierPending[r.transportadora] || 0) + r.recaudo;

    if (r.flete > 0) { fleteSum += r.flete; fleteCount++; }
    if (r.grupo === "transito" && r.dias > 0) { diasSum += r.dias; diasCount++; }

    const est = r.estado.toUpperCase() || "SIN ESTADO";
    stateCount[est] = (stateCount[est] || 0) + 1;
    stateMoney[est] = (stateMoney[est] || 0) + r.recaudo;

    if (r.grupo === "cancelado" || r.grupo === "extraviado") cityFuga[r.ciudad] = (cityFuga[r.ciudad] || 0) + 1;
  }

  const entregadas = by.entregado, enTransito = by.transito, novedad = by.novedad;
  const canceladas = by.cancelado, extraviadas = by.extraviado;
  const recaudoPendiente = recaudoPotencial - recaudoCobrado;
  const ticketPromedio = recaudoCount ? recaudoPotencial / recaudoCount : 0;
  const fletePromedio = fleteCount ? fleteSum / fleteCount : 0;
  const diasPromedio = diasCount ? diasSum / diasCount : 0;

  const pct = (n) => (total ? (n / total) * 100 : 0);
  const pendientePct = recaudoPotencial ? (recaudoPendiente / recaudoPotencial) * 100 : 0;
  const cumplimiento = pct(entregadas);
  const fuga = canceladas + extraviadas;
  const fugaPct = pct(fuga);
  const cancelPct = pct(canceladas);
  const presionFlete = ticketPromedio ? (fletePromedio / ticketPromedio) * 100 : 0;

  const topCity = Object.entries(cityFuga).sort((a, b) => b[1] - a[1])[0];
  const topCarrier = Object.entries(carrierPending).sort((a, b) => b[1] - a[1])[0];

  return {
    total, entregadas, enTransito, novedad, canceladas, extraviadas, fuga,
    backlog: enTransito + novedad,
    recaudoPotencial, recaudoCobrado, recaudoPendiente, pendientePct,
    ticketPromedio, fletePromedio, diasPromedio,
    cumplimiento, fugaPct, cancelPct, presionFlete,
    pctTransito: pct(enTransito), pctEntregadas: cumplimiento, pctExtraviadas: pct(extraviadas),
    stateCount, stateMoney, cityFuga, carrierPending,
    topFugaCity: topCity ? topCity[0] : "—",
    topPendingCarrier: topCarrier ? topCarrier[0] : "—",
    rows,
  };
}

/* --------------------------------------------------------------------
 * 6. Series temporales
 * ------------------------------------------------------------------ */

function computeSeries(rows) {
  const days = {};
  for (const r of rows) {
    const k = dateKey(r.fecha);
    if (!k) continue;
    if (!days[k]) days[k] = { entregadas: 0, transito: 0, cobrado: 0, pendiente: 0 };
    if (r.grupo === "entregado") { days[k].entregadas++; days[k].cobrado += r.recaudo; }
    else { days[k].pendiente += r.recaudo; if (r.grupo === "transito") days[k].transito++; }
  }
  const labels = Object.keys(days).sort();
  return {
    labels,
    entregadas: labels.map((l) => days[l].entregadas),
    transito: labels.map((l) => days[l].transito),
    cobrado: labels.map((l) => days[l].cobrado),
    pendiente: labels.map((l) => days[l].pendiente),
  };
}

/* --------------------------------------------------------------------
 * 7. Motor de alertas
 * ------------------------------------------------------------------ */

function buildAlerts(m) {
  const alerts = [];

  if (m.cancelPct >= TH.cancelWarning) {
    alerts.push({
      level: m.cancelPct >= TH.cancelCritical ? "critical" : "warning",
      title: "Cancelaciones elevadas",
      text: `La tasa de cancelación es ${fmtPct(m.cancelPct)}.`,
      action: "Auditar cohortes recientes y activar recuperación preventiva en pedidos de alto riesgo.",
    });
  }

  // Flete anómalo: algún estado con costo unitario proyectado > 180% del promedio.
  let anomalo = false;
  for (const [est, count] of Object.entries(m.stateCount)) {
    if (!count) continue;
    const fleteEstado = (m.rows.filter((r) => (r.estado.toUpperCase() || "SIN ESTADO") === est && r.flete > 0));
    if (!fleteEstado.length) continue;
    const avgEstado = fleteEstado.reduce((s, r) => s + r.flete, 0) / fleteEstado.length;
    if (m.fletePromedio > 0 && avgEstado > m.fletePromedio * TH.fleteEstadoAnomalo) { anomalo = true; break; }
  }
  if (anomalo) {
    alerts.push({
      level: "critical",
      title: "Flete promedio anómalo",
      text: `Hay estados con costo unitario proyectado por encima de ${Math.round(TH.fleteEstadoAnomalo * 100)}% del promedio.`,
      action: "Recalcular tarifas negociadas y auditar zonas/transportadoras con sobrecosto sostenido.",
    });
  }

  if (m.extraviadas > 0) {
    alerts.push({
      level: "critical",
      title: "Órdenes extraviadas",
      text: `Se detectaron ${fmtInt(m.extraviadas)} órdenes extraviadas (${fmtPct(m.pctExtraviadas)}).`,
      action: "Abrir reclamación con la transportadora y bloquear pago de flete de esas guías.",
    });
  }

  if (m.cumplimiento < TH.cumplRiesgo) {
    alerts.push({
      level: "critical",
      title: "Cumplimiento por debajo del umbral",
      text: `El cumplimiento de entrega es ${fmtPct(m.cumplimiento)}, bajo el mínimo de ${TH.cumplRiesgo}%.`,
      action: "Ajustar promesa comercial y rebalancear la mezcla de transportadoras.",
    });
  }

  if (m.diasPromedio > TH.transitoDeterioro) {
    alerts.push({
      level: "warning",
      title: "Deterioro de tránsito",
      text: `El tránsito promedio es de ${m.diasPromedio.toFixed(1)} días, por encima de ${TH.transitoDeterioro}.`,
      action: "Priorizar guías antiguas antes de que migren a novedad o devolución.",
    });
  }

  return alerts;
}

/* --------------------------------------------------------------------
 * 7b. Motor de decisiones accionables
 * Traduce el diagnóstico en acciones priorizadas con dinero en juego:
 * qué gestionar hoy, cuánto se puede recuperar y cuánto se está fugando.
 * ------------------------------------------------------------------ */

// Dinero (recaudo/flete) y conteo agregados por grupo de estado.
function moneyByGroup(rows) {
  const g = {
    entregado: { n: 0, rec: 0, flete: 0 }, transito: { n: 0, rec: 0, flete: 0 },
    novedad: { n: 0, rec: 0, flete: 0 }, cancelado: { n: 0, rec: 0, flete: 0 },
    extraviado: { n: 0, rec: 0, flete: 0 },
  };
  for (const r of rows) {
    const b = g[r.grupo] || (g[r.grupo] = { n: 0, rec: 0, flete: 0 });
    b.n++; b.rec += r.recaudo; b.flete += r.flete;
  }
  return g;
}

// tone -> prioridad para ordenar (rojo primero).
const DEC_RANK = { red: 0, orange: 1, yellow: 2, green: 3 };

function buildDecisions(m) {
  const g = moneyByGroup(m.rows);
  const recuperable = g.transito.rec + g.novedad.rec;   // recaudo por cobrar si se entrega
  const enFuga = g.cancelado.rec + g.extraviado.rec;    // recaudo que no se cobrará
  const decisions = [];

  // 1. Extravíos: reclamar y bloquear flete.
  if (g.extraviado.n > 0) {
    decisions.push({
      key: "extravio", label: "RECLAMAR", tone: "red",
      title: "Reclamar órdenes extraviadas", impact: g.extraviado.rec,
      detail: `${fmtInt(g.extraviado.n)} guías extraviadas · flete asociado ${fmtMoney(g.extraviado.flete)}.`,
      action: `Abre reclamación con la transportadora y bloquea el pago de flete (${fmtMoney(g.extraviado.flete)}) de esas guías.`,
    });
  }

  // 2. Novedades: gestionar antes de que migren a devolución.
  if (g.novedad.n > 0) {
    const tone = g.novedad.rec >= recuperable * 0.4 && g.novedad.n >= 5 ? "red" : "yellow";
    decisions.push({
      key: "novedad", label: "GESTIONAR", tone,
      title: "Resolver novedades pendientes", impact: g.novedad.rec,
      detail: `${fmtInt(g.novedad.n)} pedidos en novedad reteniendo ${fmtMoney(g.novedad.rec)}.`,
      action: "Contacta o reprograma en menos de 48 h antes de que migren a devolución; así recuperas ese recaudo.",
    });
  }

  // 3. Tránsito: destrabar guías antiguas (recaudo por cobrar).
  if (g.transito.n > 0) {
    const tone = m.diasPromedio > TH.transitoDeterioro ? "orange" : "yellow";
    decisions.push({
      key: "transito", label: "DESTRABAR", tone,
      title: "Acelerar entregas en tránsito", impact: g.transito.rec,
      detail: `${fmtInt(g.transito.n)} pedidos en ruta · tránsito promedio ${m.diasPromedio.toFixed(1)} días.`,
      action: `Prioriza las guías con más días en ruta; hay ${fmtMoney(g.transito.rec)} de recaudo por cobrar.`,
    });
  }

  // 4. Cancelaciones: auditar causas si superan umbral.
  if (m.cancelPct >= TH.cancelWarning) {
    decisions.push({
      key: "cancel", label: "AUDITAR", tone: m.cancelPct >= TH.cancelCritical ? "red" : "orange",
      title: "Auditar cancelaciones", impact: g.cancelado.rec,
      detail: `Cancelación en ${fmtPct(m.cancelPct)} (${fmtInt(g.cancelado.n)} pedidos, ${fmtMoney(g.cancelado.rec)} perdidos).`,
      action: "Revisa cohortes recientes (producto/zona/creativo) y activa confirmación previa para frenar la fuga.",
    });
  }

  // 5. Flete: renegociar si la presión sobre el ticket es alta.
  if (m.presionFlete > TH.fletePresionOk) {
    decisions.push({
      key: "flete", label: "OPTIMIZAR", tone: m.presionFlete > TH.fletePresionAlto ? "red" : "yellow",
      title: "Optimizar costo de flete", impact: 0,
      detail: `El flete promedio (${fmtMoney(m.fletePromedio)}) es ${fmtPct(m.presionFlete)} del ticket (${fmtMoney(m.ticketPromedio)}).`,
      action: `Renegocia tarifas y zonas con sobrecosto; el objetivo sano es ≤ ${TH.fletePresionOk}% del ticket.`,
    });
  }

  // 6. Cumplimiento / mezcla de carriers: rebalancear si baja de saludable.
  if (m.cumplimiento < TH.cumplSaludable) {
    decisions.push({
      key: "carrier", label: "REBALANCEAR", tone: m.cumplimiento < TH.cumplRiesgo ? "red" : "yellow",
      title: "Rebalancear transportadoras", impact: m.carrierPending[m.topPendingCarrier] || 0,
      detail: `Cumplimiento ${fmtPct(m.cumplimiento)} · mayor recaudo pendiente en ${m.topPendingCarrier}.`,
      action: `Reduce volumen en la transportadora con más pendiente (${m.topPendingCarrier}) y ajusta la promesa comercial.`,
    });
  }

  decisions.sort((a, b) => (DEC_RANK[a.tone] - DEC_RANK[b.tone]) || (b.impact - a.impact));

  return { decisions, recuperable, enFuga, foco: decisions.length ? decisions[0].title : "—", byGroup: g };
}

/* --------------------------------------------------------------------
 * 8. Badges de KPI
 * ------------------------------------------------------------------ */

function badge(text, tone) { return { text, tone }; }

function kpiBadges(m) {
  const riesgo = m.pendientePct < TH.riesgoEstable ? badge("Estable", "green")
    : m.pendientePct < TH.riesgoAlto ? badge("Medio", "yellow") : badge("Alto", "red");
  const cumpl = m.cumplimiento >= TH.cumplSaludable ? badge("Saludable", "green")
    : m.cumplimiento >= TH.cumplRiesgo ? badge("Aceptable", "yellow") : badge("En riesgo", "red");
  const fuga = m.fugaPct < TH.fugaBajo ? badge("Bajo", "green")
    : m.fugaPct < TH.fugaAlto ? badge("Medio", "yellow") : badge("Alto", "red");
  const presion = m.presionFlete <= TH.fletePresionOk ? badge("Sano", "green")
    : m.presionFlete <= TH.fletePresionAlto ? badge("Vigilar", "yellow") : badge("Alto", "red");
  return { riesgo, cumpl, fuga, presion };
}

/* --------------------------------------------------------------------
 * 9. Render
 * ------------------------------------------------------------------ */

let charts = {};
function destroyCharts() { Object.values(charts).forEach((c) => c && c.destroy()); charts = {}; }

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

function renderKpis(m, alerts) {
  const b = kpiBadges(m);
  const crit = alerts.filter((a) => a.level === "critical").length;
  const warn = alerts.filter((a) => a.level === "warning").length;
  const alertTone = crit ? "red" : warn ? "yellow" : "green";
  const alertBadge = crit ? "Accionar hoy" : warn ? "Revisar" : "En calma";

  const cards = [
    {
      label: "DINERO EN RIESGO", value: fmtMoney(m.recaudoPendiente), valTone: "green", badge: b.riesgo,
      sub: `${fmtPct(m.pendientePct)} del recaudo potencial sigue pendiente.`,
      foot: `Prioriza recuperación operativa en ${m.topPendingCarrier}.`,
    },
    {
      label: "CUMPLIMIENTO DE ENTREGA", value: fmtPct(m.cumplimiento), valTone: "green", badge: b.cumpl,
      sub: `${fmtInt(m.entregadas)} de ${fmtInt(m.total)} pedidos llegaron al cliente.`,
      foot: `Si baja de ${TH.cumplRiesgo}%, ajusta promesa comercial y mezcla de carriers.`,
    },
    {
      label: "FUGA OPERATIVA", value: `${fmtInt(m.fuga)} pedidos`, valTone: "orange", badge: b.fuga,
      sub: `Canceladas ${fmtInt(m.canceladas)} · Extraviadas ${fmtInt(m.extraviadas)}.`,
      foot: `El mayor impacto aparece en ${m.topFugaCity}.`,
    },
    {
      label: "BACKLOG SENSIBLE", value: `${fmtInt(m.backlog)} pedidos`, valTone: "orange", badge: badge("En curso", "orange"),
      sub: `En tránsito ${fmtInt(m.enTransito)} · En novedad ${fmtInt(m.novedad)}.`,
      foot: "Ataca primero guías antiguas para evitar que migren a devolución.",
    },
    {
      label: "PRESIÓN DE FLETE", value: fmtMoney(m.fletePromedio), valTone: "green", badge: b.presion,
      sub: `${fmtPct(m.presionFlete)} del ticket promedio (${fmtMoney(m.ticketPromedio)}).`,
      foot: `Si supera ${TH.fletePresionOk}%, revisa zonas, transportadoras y tarifas negociadas.`,
    },
    {
      label: "ALERTAS OPERATIVAS", value: `${crit} críticas / ${warn} warning`, valTone: "red", badge: badge(alertBadge, alertTone),
      sub: `Total de alertas activas: ${alerts.length}.`,
      foot: "Auditar cohortes recientes y activar recuperación preventiva en pedidos de alto riesgo.",
    },
  ];

  const wrap = document.getElementById("kpiPrimary");
  wrap.innerHTML = cards.map((c) => `
    <div class="kpi">
      <div class="kpi__head">
        <span class="kpi__label">${c.label}</span>
        <span class="tag tag--${c.badge.tone}">${c.badge.text}</span>
      </div>
      <div class="kpi__value val--${c.valTone}">${c.value}</div>
      <div class="kpi__sub">${c.sub}</div>
      <div class="kpi__foot">${c.foot}</div>
    </div>`).join("");
}

function renderStrip(m) {
  const stats = [
    { label: "ENTREGADAS", value: fmtInt(m.entregadas), tone: "green", sub: fmtPct(m.pctEntregadas) },
    { label: "EN TRÁNSITO", value: fmtInt(m.enTransito), tone: "orange", sub: `${fmtPct(m.pctTransito)} del total` },
    { label: "RECAUDO", value: fmtMoney(m.recaudoCobrado), tone: "green", sub: `Pendiente ${fmtMoney(m.recaudoPendiente)}` },
    { label: "FLETE PROMEDIO", value: fmtMoney(m.fletePromedio), tone: "orange", sub: `Promedio tránsito ${m.diasPromedio.toFixed(1)} días` },
    { label: "SIN ENTREGA / EXTRAVIADAS", value: fmtInt(m.extraviadas), tone: "red", sub: fmtPct(m.pctExtraviadas) },
    { label: "NOVEDAD", value: fmtInt(m.novedad), tone: "yellow", sub: `${fmtPct(m.total ? (m.novedad / m.total) * 100 : 0)} del total` },
  ];
  document.getElementById("kpiStrip").innerHTML = stats.map((s) => `
    <div class="stat">
      <div class="stat__label">${s.label}</div>
      <div class="stat__value val--${s.tone}">${s.value}</div>
      <div class="stat__sub">${s.sub}</div>
    </div>`).join("");
}

function renderAlerts(alerts) {
  const wrap = document.getElementById("alerts");
  if (!alerts.length) {
    wrap.innerHTML = `<div class="alert"><div class="alert__head"><h4>Sin alertas activas</h4><span class="tag tag--green">ok</span></div><p>La operación está dentro de los umbrales configurados.</p></div>`;
    return;
  }
  wrap.innerHTML = alerts.map((a) => `
    <div class="alert alert--${a.level}">
      <div class="alert__head">
        <h4>${a.title}</h4>
        <span class="tag tag--${a.level === "critical" ? "red" : "yellow"}">${a.level === "critical" ? "critical" : "warning"}</span>
      </div>
      <p>${a.text}</p>
      <p class="alert__action"><strong>Acción sugerida:</strong> ${a.action}</p>
    </div>`).join("");
}

function renderTable(m) {
  const risky = m.rows
    .filter((r) => r.grupo === "cancelado" || r.grupo === "extraviado" || r.grupo === "novedad")
    .sort((a, b) => (b.flete - a.flete) || (b.recaudo - a.recaudo))
    .slice(0, TH.topRiskRows);

  document.getElementById("tableCount").textContent = `${fmtInt(risky.length)} de ${fmtInt(m.fuga + m.novedad)} en riesgo`;
  document.getElementById("tableBody").innerHTML = risky.map((r) => `
    <tr>
      <td>${r.orden || "—"}</td>
      <td class="state-badge">${r.estado || "—"}</td>
      <td>${r.grupo === "cancelado" ? "cancelled" : r.grupo === "extraviado" ? "lost" : "issue"}</td>
      <td>${r.transportadora}</td>
      <td>${r.tracking || "—"}</td>
      <td>${r.ciudad}</td>
      <td class="num">${fmtInt(r.dias)}</td>
      <td class="num">${fmtMoney(r.recaudo)}</td>
      <td class="num">${fmtMoney(r.flete)}</td>
    </tr>`).join("");
}

function renderExec(m, alerts) {
  const crit = alerts.filter((a) => a.level === "critical").length;
  const txt = `La operación cerró con <strong>${fmtInt(m.total)}</strong> órdenes y un cumplimiento de <strong>${fmtPct(m.cumplimiento)}</strong> ` +
    `(${fmtInt(m.entregadas)} entregadas). El recaudo cobrado suma <strong>${fmtMoney(m.recaudoCobrado)}</strong> y quedan ` +
    `<strong>${fmtMoney(m.recaudoPendiente)}</strong> pendientes (${fmtPct(m.pendientePct)} del potencial), con mayor exposición en <strong>${m.topPendingCarrier}</strong>. ` +
    `La fuga operativa es de <strong>${fmtInt(m.fuga)}</strong> pedidos (${fmtPct(m.fugaPct)}), concentrada en <strong>${m.topFugaCity}</strong>, ` +
    `y el flete promedio (${fmtMoney(m.fletePromedio)}) representa el <strong>${fmtPct(m.presionFlete)}</strong> del ticket. ` +
    (crit ? `Hay <strong>${crit}</strong> alerta(s) crítica(s): prioriza recuperación de recaudo y auditoría de tarifas hoy mismo.`
          : `Sin alertas críticas: mantén el monitoreo de backlog y tránsito para sostener el cumplimiento.`);
  document.getElementById("execSummary").innerHTML = txt;
}

function renderDecisions(d) {
  const sec = document.getElementById("decisions");
  if (!sec) return;
  const tiles = [
    { label: "DINERO RECUPERABLE", value: fmtMoney(d.recuperable), tone: "green", sub: "En tránsito + novedad, si se entrega." },
    { label: "DINERO EN FUGA", value: fmtMoney(d.enFuga), tone: "red", sub: "Cancelado + extraviado (no se cobrará)." },
    { label: "ACCIONES PRIORIZADAS", value: fmtInt(d.decisions.length), tone: "orange", sub: "Ordenadas por urgencia e impacto." },
    { label: "FOCO PRINCIPAL", value: d.foco, tone: "yellow", sub: "Empieza por aquí hoy.", small: true },
  ];
  document.getElementById("decSummary").innerHTML = tiles.map((t) => `
    <div class="dec-tile">
      <div class="dec-tile__label">${t.label}</div>
      <div class="dec-tile__value val--${t.tone}${t.small ? " dec-tile__value--sm" : ""}">${t.value}</div>
      <div class="dec-tile__sub">${t.sub}</div>
    </div>`).join("");

  if (!d.decisions.length) {
    document.getElementById("decList").innerHTML = `<div class="dec-row"><div class="dec-row__body"><h4>Sin acciones urgentes</h4><p>La operación está dentro de los umbrales: mantén el monitoreo de backlog y tránsito.</p></div></div>`;
    sec.hidden = false;
    return;
  }

  document.getElementById("decList").innerHTML = d.decisions.map((x) => `
    <div class="dec-row dec-row--${x.tone}">
      <div class="dec-row__badge tag tag--${x.tone}">${x.label}</div>
      <div class="dec-row__body">
        <div class="dec-row__title"><h4>${x.title}</h4>${x.impact > 0 ? `<span class="dec-row__impact">${fmtMoney(x.impact)}</span>` : ""}</div>
        <p class="dec-row__detail">${x.detail}</p>
        <p class="dec-row__action"><strong>Acción:</strong> ${x.action}</p>
      </div>
    </div>`).join("");
  sec.hidden = false;
}

/* --------------------------------------------------------------------
 * 10. Gráficos (Chart.js)
 * ------------------------------------------------------------------ */

function chartDefaults() {
  Chart.defaults.color = "#8a97ac";
  Chart.defaults.borderColor = "#1e2636";
  Chart.defaults.font.family = "Inter, Segoe UI, system-ui, sans-serif";
}

function renderCharts(m, series) {
  destroyCharts();
  chartDefaults();

  charts.daily = new Chart(document.getElementById("chartDaily"), {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        { label: "Entregadas", data: series.entregadas, borderColor: "#34d399", backgroundColor: "rgba(52,211,153,.18)", fill: true, tension: .35, pointRadius: 2 },
        { label: "En tránsito", data: series.transito, borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,.10)", fill: true, tension: .35, pointRadius: 2 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top" } }, scales: { x: { grid: { display: false } } } },
  });

  charts.money = new Chart(document.getElementById("chartMoney"), {
    type: "bar",
    data: {
      labels: series.labels,
      datasets: [
        { label: "Recaudo cobrado", data: series.cobrado, backgroundColor: "#f5822e" },
        { label: "Recaudo pendiente", data: series.pendiente, backgroundColor: "#f87171" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top" } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => new Intl.NumberFormat("es-CO").format(v) } } } },
  });

  const stEntries = Object.entries(m.stateCount).sort((a, b) => b[1] - a[1]);
  charts.states = new Chart(document.getElementById("chartStates"), {
    type: "doughnut",
    data: { labels: stEntries.map((e) => e[0]),
      datasets: [{ data: stEntries.map((e) => e[1]), backgroundColor: stEntries.map((_, i) => STATE_COLORS[i % STATE_COLORS.length]), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 10 } } } } },
  });

  const mnEntries = Object.entries(m.stateMoney).sort((a, b) => b[1] - a[1]).slice(0, 8);
  charts.moneyStates = new Chart(document.getElementById("chartMoneyStates"), {
    type: "bar",
    data: { labels: mnEntries.map((e) => e[0]),
      datasets: [{ label: "COD por estado", data: mnEntries.map((e) => e[1]), backgroundColor: "#f5822e" }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top" } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 30, font: { size: 10 } } },
        y: { ticks: { callback: (v) => new Intl.NumberFormat("es-CO").format(v) } } } },
  });
}

/* --------------------------------------------------------------------
 * 11. Orquestación
 * ------------------------------------------------------------------ */

function analyze(rows) {
  const m = computeMetrics(rows);
  const series = computeSeries(rows);
  const alerts = buildAlerts(m);
  const decisions = buildDecisions(m);

  renderKpis(m, alerts);
  renderStrip(m);
  renderDecisions(decisions);
  renderAlerts(alerts);
  renderTable(m);
  renderExec(m, alerts);
  renderCharts(m, series);

  document.getElementById("emptyState").hidden = true;
  document.getElementById("results").hidden = false;
  const badgeEl = document.getElementById("statusBadge");
  badgeEl.textContent = "ANÁLISIS COMPLETADO";
  badgeEl.classList.add("is-done");
  document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
        resolve(normalizeRows(matrix));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

/* --------------------------------------------------------------------
 * 12. UI wiring
 * ------------------------------------------------------------------ */

function init() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const clearBtn = document.getElementById("clearBtn");
  const fileMeta = document.getElementById("fileMeta");
  const uploadError = document.getElementById("uploadError");
  const statusBadge = document.getElementById("statusBadge");
  let selectedFile = null;

  const VALID_EXT = /\.(xlsx|xls|csv)$/i;

  function setFile(file) {
    selectedFile = file;
    uploadError.hidden = true;
    if (file) {
      fileMeta.hidden = false;
      fileMeta.textContent = `${file.name} · ${(file.size / 1048576).toFixed(2)} MB`;
      analyzeBtn.disabled = false;
    } else {
      fileMeta.hidden = true;
      analyzeBtn.disabled = true;
    }
  }

  function showError(msg) {
    uploadError.hidden = false;
    uploadError.textContent = msg;
    statusBadge.textContent = "REVISA EL ARCHIVO";
    statusBadge.classList.remove("is-done");
  }

  // Analiza el archivo seleccionado. Nunca deja una excepción sin capturar.
  async function runAnalysis() {
    if (!selectedFile) return;
    if (!VALID_EXT.test(selectedFile.name)) {
      showError("Formato no admitido. Sube un archivo .xlsx, .xls o .csv exportado de Dropi.");
      return;
    }
    uploadError.hidden = true;
    analyzeBtn.disabled = true;
    const prevLabel = analyzeBtn.textContent;
    analyzeBtn.textContent = "Analizando…";
    statusBadge.textContent = "ANALIZANDO…";
    try {
      const rows = await parseFile(selectedFile);
      analyze(rows);
    } catch (err) {
      showError("No se pudo analizar el reporte: " + (err && err.message ? err.message : "archivo no reconocido") +
        ". Verifica que sea el reporte de órdenes exportado de Dropi.");
      console.error(err);
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = prevLabel;
    }
  }

  // Selección de archivo -> análisis automático (sin pulsar el botón).
  function onFileChosen(file) {
    if (!file) return;
    setFile(file);
    runAnalysis();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => onFileChosen(fileInput.files[0]));

  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("is-drag"); }));
  dropzone.addEventListener("drop", (e) => onFileChosen(e.dataTransfer.files[0]));

  analyzeBtn.addEventListener("click", runAnalysis);

  clearBtn.addEventListener("click", () => {
    setFile(null); fileInput.value = ""; destroyCharts();
    document.getElementById("results").hidden = true;
    document.getElementById("emptyState").hidden = false;
    statusBadge.textContent = "LISTO PARA CARGAR"; statusBadge.classList.remove("is-done");
    uploadError.hidden = true;
  });
}

// Arranque solo en el navegador; en Node se exporta el motor para pruebas.
if (typeof document !== "undefined") {
  init();
} else if (typeof module !== "undefined" && module.exports) {
  module.exports = { norm, toNumber, toDate, groupOfState, normalizeRows, computeMetrics, computeSeries, buildAlerts, buildDecisions, moneyByGroup, kpiBadges };
}
