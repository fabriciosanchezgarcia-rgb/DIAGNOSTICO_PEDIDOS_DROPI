/* Genera un reporte de ejemplo estilo Dropi (CSV) para probar el analizador.
 * No es data real: reproduce proporciones parecidas a un reporte típico.
 * Uso:  node sample/generate_sample.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

function rnd(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad(n) { return String(n).padStart(2, "0"); }

const CARRIERS = ["ENVIA", "INTERRAPIDISIMO", "SERVIENTREGA", "COORDINADORA", "TCC"];
const CITIES = [
  ["CUNDINAMARCA", "BOGOTA"], ["ANTIOQUIA", "MEDELLIN"], ["VALLE DEL CAUCA", "CALI"],
  ["ATLANTICO", "BARRANQUILLA"], ["SANTANDER", "BUCARAMANGA"], ["BOLIVAR", "CARTAGENA"],
  ["CALDAS", "MANIZALES"], ["RISARALDA", "PEREIRA"], ["TOLIMA", "IBAGUE"], ["META", "VILLAVICENCIO"],
  ["CORDOBA", "MONTERIA"], ["NARIÑO", "PASTO"], ["HUILA", "NEIVA"], ["MAGDALENA", "SANTA MARTA"],
];
const TRANSIT_STATES = [
  "EN REPARTO", "DESPACHADA", "EN BODEGA TRANSPORTADORA", "INTENTO DE ENTREGA",
  "TELEMERCADEO", "EN PROCESAMIENTO", "EN BODEGA DESTINO", "EN BODEGA ORIGEN",
  "EN REEXPEDICION", "CITA PROGRAMADA",
];
const NOVEDAD_STATES = ["NOVEDAD", "RECLAME EN OFICINA", "EN ESPERA DE RX"];

// Distribución objetivo (~2345 órdenes).
const PLAN = [
  { state: "ENTREGADO", n: 1735, group: "entregado" },
  { state: "DEVOLUCION", n: 233, group: "cancelado" },
  { state: null, n: 84, group: "novedad" },
  { state: null, n: 293, group: "transito" },
];

// Ventana temporal con pico a comienzos de mayo.
function randomDate() {
  const start = new Date(2026, 3, 27); // 27 abr
  const spanDays = 19;
  // sesgo hacia el centro (pico)
  const t = (Math.random() + Math.random()) / 2;
  const offset = Math.floor(t * spanDays);
  const d = new Date(start.getTime() + offset * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cod() {
  // Ticket alrededor de 45k–100k (promedio ~72.8k).
  return Math.round(rnd(45000, 100000) / 100) * 100;
}

const rows = [];
let id = 74040000;
let guia = 240051560000;

for (const bucket of PLAN) {
  for (let i = 0; i < bucket.n; i++) {
    let state = bucket.state;
    if (bucket.group === "novedad") state = pick(NOVEDAD_STATES);
    if (bucket.group === "transito") state = pick(TRANSIT_STATES);

    const [depto, city] = pick(CITIES);
    // Pendiente concentrado en ENVIA; cancelaciones concentradas en BOGOTA.
    let carrier = pick(CARRIERS);
    if (bucket.group !== "entregado" && Math.random() < 0.4) carrier = "ENVIA";
    const cityFinal = bucket.group === "cancelado" && Math.random() < 0.35 ? "BOGOTA" : city;
    const deptoFinal = cityFinal === "BOGOTA" ? "CUNDINAMARCA" : depto;

    // Flete ~10k–24k; algunos estados con sobrecosto para disparar alerta crítica.
    let flete = Math.round(rnd(10000, 24000));
    if (state === "CITA PROGRAMADA" || state === "EN REEXPEDICION") flete = Math.round(rnd(34000, 44000));

    // Tránsito bajo (~1.5 días); cancelados/devoluciones pueden llevar más tiempo.
    const dias = bucket.group === "transito"
      ? Math.floor(rnd(1, 4))
      : bucket.group === "entregado" ? Math.floor(rnd(0, 3)) : Math.floor(rnd(1, 15));

    rows.push({
      ID: id++,
      FECHA: randomDate(),
      ESTATUS: state,
      TRANSPORTADORA: carrier,
      GUIA: guia++,
      DEPARTAMENTO: deptoFinal,
      "CIUDAD DE DESTINO": cityFinal,
      "TOTAL DE LA ORDEN": cod(),
      "PRECIO FLETE": flete,
      "DIAS DE TRANSITO": dias,
    });
  }
}

// Mezcla las filas para que las fechas/estados queden entrelazados.
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }

const headers = Object.keys(rows[0]);
const csv = [headers.join(",")]
  .concat(rows.map((r) => headers.map((h) => r[h]).join(",")))
  .join("\n");

const out = path.join(__dirname, "ordenes_productos_ejemplo.csv");
fs.writeFileSync(out, csv, "utf8");
console.log(`Generado ${rows.length} filas -> ${out}`);
