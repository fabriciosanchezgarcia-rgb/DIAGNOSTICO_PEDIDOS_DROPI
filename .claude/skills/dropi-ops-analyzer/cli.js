#!/usr/bin/env node
/* Analiza un reporte de Dropi (XLSX/CSV) desde la línea de comandos usando el
 * mismo motor que la app web (assets/app.js). Imprime un diagnóstico en texto.
 *
 * Uso (desde la raíz del repo):
 *   node .claude/skills/dropi-ops-analyzer/cli.js <ruta-al-reporte.xlsx|csv>
 *
 * Requiere el paquete xlsx:  npm i xlsx@0.18.5
 */
"use strict";
const path = require("path");

const file = process.argv[2];
if (!file) {
  console.error("Uso: node cli.js <ruta-al-reporte.xlsx|csv>");
  process.exit(2);
}

let XLSX;
try {
  XLSX = require("xlsx");
} catch (e) {
  console.error("Falta el paquete 'xlsx'. Instálalo con:  npm i xlsx@0.18.5");
  process.exit(3);
}

const eng = require(path.join(__dirname, "..", "..", "..", "assets", "app.js"));

function money(n) { return "$ " + new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(Math.round(n || 0)); }
function int(n) { return new Intl.NumberFormat("es-CO").format(Math.round(n || 0)); }
function pct(n) { return (isFinite(n) ? n : 0).toFixed(1) + "%"; }

let matrix;
try {
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
} catch (e) {
  console.error("No se pudo leer el archivo:", e.message);
  process.exit(1);
}

let m, alerts;
try {
  const rows = eng.normalizeRows(matrix);
  m = eng.computeMetrics(rows);
  alerts = eng.buildAlerts(m);
} catch (e) {
  console.error("No se pudo analizar el reporte:", e.message);
  console.error("Verifica que sea el reporte de órdenes exportado de Dropi.");
  process.exit(1);
}

const L = [];
L.push("========================================================");
L.push("  DROPI OPS ANALYZER — Diagnóstico operativo");
L.push("  Archivo: " + path.basename(file));
L.push("========================================================");
L.push("");
L.push("RESUMEN");
L.push(`  Órdenes totales........... ${int(m.total)}`);
L.push(`  Cumplimiento de entrega... ${pct(m.cumplimiento)}  (${int(m.entregadas)} entregadas)`);
L.push(`  En tránsito............... ${int(m.enTransito)}  (${pct(m.pctTransito)})`);
L.push(`  Novedad................... ${int(m.novedad)}`);
L.push(`  Canceladas................ ${int(m.canceladas)}  (${pct(m.cancelPct)})`);
L.push(`  Extraviadas............... ${int(m.extraviadas)}`);
L.push(`  Backlog sensible.......... ${int(m.backlog)}  (tránsito + novedad)`);
L.push("");
L.push("RECAUDO (COD)");
L.push(`  Recaudo potencial......... ${money(m.recaudoPotencial)}`);
L.push(`  Recaudo cobrado........... ${money(m.recaudoCobrado)}`);
L.push(`  Dinero en riesgo.......... ${money(m.recaudoPendiente)}  (${pct(m.pendientePct)} pendiente)`);
L.push(`  Ticket promedio........... ${money(m.ticketPromedio)}`);
L.push(`  Mayor exposición en....... ${m.topPendingCarrier}`);
L.push("");
L.push("FLETE");
L.push(`  Flete promedio............ ${money(m.fletePromedio)}`);
L.push(`  Presión de flete.......... ${pct(m.presionFlete)} del ticket`);
L.push(`  Días de tránsito (prom.).. ${m.diasPromedio.toFixed(1)}`);
L.push("");
L.push("FUGA OPERATIVA");
L.push(`  Fuga (cancel + extrav.)... ${int(m.fuga)}  (${pct(m.fugaPct)})`);
L.push(`  Mayor impacto en.......... ${m.topFugaCity}`);
L.push("");
L.push("ALERTAS (" + alerts.length + ")");
if (!alerts.length) L.push("  Sin alertas activas.");
alerts.forEach((a) => {
  L.push(`  [${a.level.toUpperCase()}] ${a.title}`);
  L.push(`      ${a.text}`);
  L.push(`      Acción: ${a.action}`);
});
L.push("");
L.push("DISTRIBUCIÓN POR ESTADO");
Object.entries(m.stateCount).sort((a, b) => b[1] - a[1]).forEach(([est, c]) => {
  L.push(`  ${est.padEnd(28)} ${String(int(c)).padStart(6)}   ${money(m.stateMoney[est] || 0)}`);
});
L.push("");
console.log(L.join("\n"));
