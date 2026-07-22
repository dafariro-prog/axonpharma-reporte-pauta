# Reporte de Pauta Mensual · Axon Pharma Colombia

Réplica web de la plantilla de reporte del cliente (solo bloque de **pauta**), con
data real conectada y **filtro por mes**. Marcas: Marimer, Floratil, A-Cerumen.

## Fuentes de datos (`data/`)
- `meta.json` — Meta Ads (Windsor, cuenta `1211531357024604`): Awareness + Traffic.
- `google_ads.json` — Google Ads Search (BigQuery `MCC_AXON_PHARMA`).
- `tiktok.json` — TikTok Ads (Windsor, cuenta `7512240273293279239`), convertido USD→COP (TC 3.800).
- `creatives.json` — thumbnails reales de anuncios Meta por mes/marca/plataforma (top por inversión).

Moneda COP. Solo se muestran meses de 2026.

## Estructura
Por marca: banner (imagen de la plantilla) → intro → por plataforma (Awareness / Traffic / TikTok / Search):
tarjeta de resultados + análisis + creativos reales del mes → resumen de marca.

## Notas
- Estructura, storytelling y banners: plantilla del cliente. Cifras: data real conectada.
- Métricas no conectadas (orgánico, interacciones/reactions, % top-of-page de Search) no se muestran.
- Los thumbnails de Meta son URLs temporales (fbcdn); se refrescan al regenerar `creatives.json`.

## Preview local
```bash
node server.js   # http://127.0.0.1:8766
```
