---
name: dropi-ops-analyzer
description: Analiza un reporte de pedidos exportado de Dropi (XLSX o CSV) y produce el diagnóstico operativo — cumplimiento de entrega, recaudo cobrado vs. pendiente (dinero en riesgo), fuga operativa, presión de flete, alertas y órdenes de alto riesgo — o publica/abre la app web "Dropi Ops Analyzer". Usar SIEMPRE que el usuario adjunte un reporte de Dropi, escriba "analiza mis pedidos de Dropi", "diagnóstico operativo de pedidos", "sube/subí un reporte de Dropi", o pida abrir, publicar o actualizar la app Dropi Ops Analyzer.
---

# Dropi Ops Analyzer

Herramienta de diagnóstico operativo para reportes de Dropi. Tiene dos modos.
El motor de cálculo es único: `assets/app.js` en la raíz del repo (mismas fórmulas
en la web y en el CLI), así que ambos modos dan resultados idénticos.

## Modo A — Analizar un reporte adjuntado en el chat

Cuando el usuario adjunte o indique la ruta de un reporte de Dropi (`.xlsx`, `.xls`
o `.csv`), analízalo con el CLI y devuelve el diagnóstico en texto:

```bash
# Desde la raíz del repo. Instala xlsx la primera vez si hace falta.
npm ls xlsx >/dev/null 2>&1 || npm i xlsx@0.18.5
node .claude/skills/dropi-ops-analyzer/cli.js <ruta-al-reporte>
```

El CLI imprime: resumen de estados, recaudo (potencial/cobrado/en riesgo),
flete y presión, fuga operativa por ciudad, alertas y distribución por estado.
Nunca lanza una excepción cruda: si el archivo no es un reporte de Dropi válido,
explica qué falta. Presenta el resultado al usuario y ofrece abrir la app web
para verlo con gráficos.

## Modo B — Abrir / publicar / actualizar la app web

La app es una página autónoma (`app.html` en esta carpeta) que corre 100% en el
navegador: el usuario sube su reporte y obtiene KPIs, gráficos, alertas y la tabla
de órdenes de alto riesgo. **Analiza automáticamente al soltar el archivo** y abre
con datos de ejemplo cargados (marcados como tales).

- **Abrir por primera vez / publicar**: publica `app.html` con la herramienta
  Artifact (favicon 📦). Entrega el enlace al usuario.
- **Actualizar la ya publicada**: si el usuario ya tiene una versión publicada,
  actualízala sobre el MISMO enlace pasando su `url` a la herramienta Artifact
  (no publiques una nueva). Si no recuerdas la URL, pídesela o búscala con
  `action: "list"`.
- **Regenerar `app.html`** tras cambios en `index.html`, `assets/styles.css` o
  `assets/app.js`: reconstruye el archivo autónomo (inlina CSS + JS, añade XLSX y
  Chart.js desde cdnjs y precarga el CSV de ejemplo). El script de ensamblaje de
  referencia está documentado en el historial del repo; en resumen, toma el
  `<body>` de `index.html`, reemplaza los `<script>`/`<link>` locales por los CDN
  y un `<style>` inline, y añade un bootstrap que carga `sample/…csv`.

## Qué lee del reporte

El parser reconoce el encabezado automáticamente y mapea variantes de nombre a
campos canónicos (`COLUMN_ALIASES` en `assets/app.js`): orden, estado,
transportadora, tracking/guía, ciudad, departamento, recaudo (TOTAL DE LA ORDEN),
flete (PRECIO FLETE), fecha y días de tránsito. Acepta formato monetario
colombiano (`$ 93.900`) y varias formas de fecha. Los estados se agrupan en
entregado / tránsito / novedad / cancelado / extraviado; cualquier estado
desconocido cuenta como tránsito, de modo que el análisis nunca se rompe por un
estado nuevo.

Si un export usa encabezados que no reconoce, añade el alias a `COLUMN_ALIASES`
en `assets/app.js` (y regenera `app.html` para la web).

## Fórmulas y umbrales

Documentados en el `README.md` de la raíz del repo (tabla de fórmulas y umbrales
de badges/alertas). Los umbrales viven en el objeto `TH` de `assets/app.js` y son
el único lugar a tocar para ajustarlos.
