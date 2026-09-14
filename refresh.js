#!/usr/bin/env node
/**
 * Refresca la data del reporte de pauta Axon Pharma desde Windsor.ai:
 *   - data/meta.json      (Meta Ads, cuenta 1211531357024604)
 *   - data/tiktok.json    (TikTok Ads, cuenta 7512240273293279239, USD->COP)
 *   - data/creatives.json (creativos reales: Meta image_url + TikTok video_thumbnail_url)
 *
 * data/google_ads.json (Google Search, BigQuery) NO se toca: es snapshot histórico.
 *
 * INCREMENTAL por defecto: la historia (2025→) queda persistida en data/*.json (repo);
 * cada corrida solo baja los últimos ~35 días (diario) y el mes actual+anterior (agregados),
 * y los FUSIONA sobre lo guardado. Backfill completo: FULL=1 node refresh.js
 *
 * Requiere Node 18+ y WINDSOR_API_KEY. Procesa 2025–2026.
 * Uso: WINDSOR_API_KEY=xxxx node refresh.js   |   FULL=1 WINDSOR_API_KEY=xxxx node refresh.js
 */
const fs = require('fs');
const path = require('path');

const RAW_KEY  = (process.env.WINDSOR_API_KEY || '').trim();
const API_KEY  = (RAW_KEY.match(/api_key=([^&\s]+)/i)?.[1] || RAW_KEY).trim();
const FB_ACCT  = '1211531357024604';
const TT_ACCT  = '7512240273293279239';
const RATE     = 3800;                 // USD -> COP (TikTok)
const DAY      = 86400000;
const FULL     = process.env.FULL === '1';   // backfill completo (rebaja todo 2025→hoy). Por defecto: INCREMENTAL.
const TO       = new Date().toISOString().slice(0, 10);
const TOP_ADS  = 6;
const _n = new Date();
// INCREMENTAL: la historia ya está persistida en data/*.json (repo). Cada corrida solo baja lo reciente y lo fusiona:
//  - diario (meta/tiktok): últimos 35 días  →  reemplaza esos días, conserva todo lo anterior.
//  - agregados mensuales (reach/adsets): mes actual + mes anterior  →  reemplaza esos meses, conserva los viejos.
const FROM      = FULL ? '2025-01-01' : new Date(_n.getTime() - 35*DAY).toISOString().slice(0,10);   // diario
const _mf       = new Date(Date.UTC(_n.getUTCFullYear(), _n.getUTCMonth()-1, 1));                     // 1er día del mes anterior
const MONTH_FROM = FULL ? '2025-01-01' : _mf.toISOString().slice(0,10);                               // agregados mensuales
// Creativos (image_url es lento): ventana de 3 meses atrás; se fusiona con los meses viejos ya guardados.
const _w = new Date(Date.UTC(_n.getUTCFullYear(), _n.getUTCMonth()-3, 1));
const CRE_FROM = FULL ? '2025-01-01' : _w.toISOString().slice(0,10);

if (!API_KEY) { console.error('ERROR: falta WINDSOR_API_KEY'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const normMonth = m => { m = String(m).trim(); if (/^\d{4}-\d{2}/.test(m)) return m.slice(0,7); if (/^\d{1,2}$/.test(m)) return '2026-'+pad(m); return m; };
// Windsor devuelve `month` sin año ("06"); combinar con el campo `year` para evitar colisión 2025/2026.
const ymOf = r => { const y=String(r.year||'').match(/^\d{4}$/)?String(r.year):null; const mo=pad(+r.month); return (y && /^\d{2}$/.test(mo)) ? y+'-'+mo : normMonth(r.month); };
const https = u => String(u||'').replace(/^http:\/\//, 'https://');
const PRODUCTS = ['A-CERUMEN','MARIMER&FLORATIL','MARIMER','FLORATIL'];
const productOf = c => { const u=(c||'').toUpperCase(); for(const p of PRODUCTS) if(u.includes(p)) return p==='MARIMER&FLORATIL'?'MARIMER & FLORATIL':p; return 'Otros'; };
const cleanMeta = n => String(n).replace(/^\w+_CO_AxonPharma_/i,'').replace(/_(Traffic|Awareness)_.*$/i,'').replace(/_/g,' ').replace(/\s+/g,' ').trim();
const cleanTT   = n => String(n).replace(/^\w+_AXONPHARMA_/i,'').replace(/\.(mp4|mov).*/i,'').replace(/_\$[\d.,]+.*$/,'').replace(/_20\d\d-.*/,'').replace(/_/g,' ').replace(/\s+/g,' ').trim() || n;

async function win(connector, fields, { from=FROM, to=TO, account } = {}) {
  const params = { api_key: API_KEY, date_from: from, date_to: to, fields: fields.join(',') };
  if (account) params.account = account;   // filtro server-side por cuenta (mucho más rápido)
  const url = `https://connectors.windsor.ai/${connector}?` + new URLSearchParams(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${connector} API HTTP ${res.status} :: ${(await res.text()).slice(0,150)}`);
  const j = await res.json();
  return (j.data || j.result || []);
}

const readJson = p => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } };

(async () => {
  const dataDir = path.join(__dirname, 'data');
  const warns = [];

  // ---------- META (diario, incremental) ----------
  const mAll = await win('facebook', ['account_id','campaign','objective','date','spend','impressions',
    'reach','frequency','clicks','link_clicks','cpc','cpm','ctr'], {account:FB_ACCT});   // from=FROM (ventana diaria)
  const mFresh = mAll.filter(r => String(r.account_id) === FB_ACCT).map(r => ({
    campaign:r.campaign, objective:r.objective, date:r.date,
    spend:+r.spend||0, impressions:+r.impressions||0, reach:+r.reach||0, frequency:+r.frequency||0,
    clicks:+r.clicks||0, link_clicks:+r.link_clicks||0, cpc:+r.cpc||0, cpm:+r.cpm||0, ctr:+r.ctr||0,
  })).filter(r => r.date && r.impressions > 0);
  const mKept = ((readJson(path.join(dataDir,'meta.json'))||{}).rows||[]).filter(r => r.date && r.date < FROM); // historia previa a la ventana
  const metaRows = mKept.concat(mFresh).sort((a,b)=> a.date<b.date?-1:1);
  fs.writeFileSync(path.join(dataDir,'meta.json'), JSON.stringify({
    updated:new Date().toISOString(), account:{id:FB_ACCT,name:'Axon Pharma Colombia',connector:'facebook',currency:'COP'}, rows:metaRows }, null, 2));

  // ---------- TIKTOK (diario, USD->COP) ----------
  // Resiliente: si la cuenta de TikTok no está disponible en Windsor, NO abortamos el refresco;
  // conservamos la data previa de TikTok y seguimos actualizando Meta/creativos/adsets/reach.
  let ttOk = true, ttRows = [], tCr = [], tReach = [];
  try {
    const tAll = await win('tiktok', ['account_id','campaign','date','spend','impressions','reach',
      'clicks','video_views','cpc','cpm','ctr','frequency'], {account:TT_ACCT});
    ttRows = tAll.filter(r => String(r.account_id) === TT_ACCT).map(r => {
      const spend = Math.round((+r.spend||0)*RATE), impressions=+r.impressions||0, clicks=+r.clicks||0;
      return { campaign:r.campaign, objective:/awareness|awarenes/i.test(r.campaign)?'OUTCOME_AWARENESS':'LINK_CLICKS',
        date:r.date, spend, impressions, reach:+r.reach||0, frequency:+r.frequency||0,
        clicks, link_clicks:clicks, views:+r.video_views||0,
        cpc:clicks?+(spend/clicks).toFixed(2):0, cpm:impressions?+(spend/impressions*1000).toFixed(2):0,
        ctr:impressions?+(clicks/impressions*100).toFixed(4):0 };
    }).filter(r => r.date && r.spend > 0);
    const ttKept = ((readJson(path.join(dataDir,'tiktok.json'))||{}).rows||[]).filter(r => r.date && r.date < FROM);
    ttRows = ttKept.concat(ttRows).sort((a,b)=> a.date<b.date?-1:1);
    fs.writeFileSync(path.join(dataDir,'tiktok.json'), JSON.stringify({
      updated:new Date().toISOString(), account:{id:TT_ACCT,name:'CO_AxonPharma_GarnierCOLOMBIA',currency:'COP',note:'USD->COP TC 3.800'}, rows:ttRows }, null, 2));
  } catch (e) {
    ttOk = false;
    warns.push(`TikTok NO actualizado (cuenta ${TT_ACCT} no disponible en Windsor): ${String(e.message||e).slice(0,120)}`);
    // conservamos data/tiktok.json existente tal cual (no se sobreescribe)
  }

  // ---------- REACH mensual único por campaña (alcance/frecuencia NO son aditivos) ----------
  // Base = reach.json existente (preserva TikTok si está caído); Meta siempre se re-escribe, TikTok solo si ttOk.
  const reachPrev = (readJson(path.join(dataDir,'reach.json'))||{}).months || {};
  // FULL: rehacer desde cero (limpia residuos del año mal asignado). Incremental: limpiar solo los meses que se repueblan.
  const reachMonths = FULL ? {} : JSON.parse(JSON.stringify(reachPrev));
  if (!FULL) { const cut = MONTH_FROM.slice(0,7); for (const m in reachMonths) if (m >= cut) delete reachMonths[m]; }
  const addReach = rows => rows.forEach(r => {
    const m = ymOf(r); if (!/^202[56]/.test(m)) return;
    (reachMonths[m] = reachMonths[m] || {})[String(r.campaign).trim()] = { reach:+r.reach||0, freq:+r.frequency||0 };
  });
  addReach((await win('facebook', ['account_id','year','month','campaign','reach','frequency'], {account:FB_ACCT, from:MONTH_FROM})).filter(r=>String(r.account_id)===FB_ACCT));
  if (ttOk) { try {
    addReach((await win('tiktok', ['account_id','year','month','campaign','reach','frequency'], {account:TT_ACCT, from:MONTH_FROM})).filter(r=>String(r.account_id)===TT_ACCT));
  } catch(e){ warns.push('TikTok reach no actualizado: '+String(e.message||e).slice(0,80)); } }
  fs.writeFileSync(path.join(dataDir,'reach.json'), JSON.stringify({ source:'Meta+TikTok reach mensual único', updated:new Date().toISOString(), months:reachMonths }, null, 2));

  // ---------- CREATIVOS (Meta image_url + TikTok video_thumbnail_url) ----------
  // Best-effort: solo la ventana rodante (image_url es lento); se fusiona con los meses viejos ya guardados.
  // Si falla (p. ej. timeout de Windsor), se conserva creatives.json previo y NO se aborta el refresco.
  try {
    const acc = {};
    const addCr = (month, brand, plat, ad, img, spend, impr, clk) => {
      if (!/^http/.test(img||'')) return;
      const key = month+'|'+brand+'|'+plat+'|'+ad;
      const a = acc[key] || (acc[key] = { month, brand, plat, ad_name:ad, thumbnail:https(img), spend:0, impressions:0, clicks:0 });
      a.thumbnail = https(img); a.spend += spend; a.impressions += impr; a.clicks += clk;
    };
    const mCr = await win('facebook', ['account_id','year','month','campaign','ad_name','image_url','effective_instagram_media__media_url','thumbnail_url','spend','impressions','clicks'], {account:FB_ACCT, from:CRE_FROM});
    mCr.filter(r => String(r.account_id) === FB_ACCT).forEach(r => {
      const m = ymOf(r); if (!/^202[56]/.test(m)) return;
      // prioridad: creativo real (image_url) -> imagen real del post IG -> thumbnail genérico (último recurso, evita tarjetas de texto)
      const img = /^http/.test(r.image_url||'') ? r.image_url
                : (/^http/.test(r.effective_instagram_media__media_url||'') ? r.effective_instagram_media__media_url : r.thumbnail_url);
      addCr(m, productOf(r.campaign), /traffic/i.test(r.campaign)?'Traffic':'Awareness', r.ad_name, img, +r.spend||0, +r.impressions||0, +r.clicks||0);
    });
    if (ttOk) { try {
      tCr = await win('tiktok', ['account_id','year','month','campaign','ad_name','video_thumbnail_url','spend','impressions','clicks'], {account:TT_ACCT, from:CRE_FROM});
      tCr.filter(r => String(r.account_id) === TT_ACCT).forEach(r => {
        const m = ymOf(r); if (!/^202[56]/.test(m)) return;
        addCr(m, productOf(r.campaign), 'TikTok', r.ad_name, r.video_thumbnail_url, (+r.spend||0)*RATE, +r.impressions||0, +r.clicks||0);
      });
    } catch(e){ ttOk=false; warns.push('TikTok creativos no actualizado: '+String(e.message||e).slice(0,80)); } }
    const fresh = {};
    Object.values(acc).forEach(a => {
      a.cpm=a.impressions?+(a.spend/a.impressions*1000).toFixed(2):0;
      a.cpc=a.clicks?+(a.spend/a.clicks).toFixed(2):0;
      a.ctr=a.impressions?+(a.clicks/a.impressions*100).toFixed(2):0;
      const M=fresh[a.month]||(fresh[a.month]={}), B=M[a.brand]||(M[a.brand]={});
      (B[a.plat]||(B[a.plat]=[])).push({thumbnail:a.thumbnail,ad_name:a.ad_name,spend:Math.round(a.spend),impressions:a.impressions,clicks:a.clicks,cpm:a.cpm,cpc:a.cpc,ctr:a.ctr});
    });
    for(const m in fresh) for(const b in fresh[m]) for(const p in fresh[m][b])
      fresh[m][b][p] = fresh[m][b][p].sort((x,y)=>y.ctr-x.ctr).slice(0, TOP_ADS);
    // fusión: base = meses previos; se sobreescriben los meses de la ventana con lo fresco
    const prev = (readJson(path.join(dataDir,'creatives.json'))||{}).months || {};
    const months = JSON.parse(JSON.stringify(prev));
    for(const m in fresh) months[m] = fresh[m];
    if (!ttOk) { // preservar creativos TikTok previos en los meses re-escritos
      for(const m in prev) for(const b in prev[m]) if(prev[m][b].TikTok){
        (months[m]=months[m]||{}); (months[m][b]=months[m][b]||{}); months[m][b].TikTok = prev[m][b].TikTok;
      }
    }
    fs.writeFileSync(path.join(dataDir,'creatives.json'), JSON.stringify({ source:'Meta(image_url)+TikTok', updated:new Date().toISOString(), months }, null, 2));
  } catch(e){ warns.push('Creativos no actualizados (se conserva lo previo): '+String(e.message||e).slice(0,100)); }

  // ---------- ADSETS / ADS (tabla resumen: Meta adsets + TikTok ads) ----------
  // Best-effort: si falla, se conserva adsets.json previo y no se aborta el refresco.
  let adMonthsCount = 0;
  try {
    const adAcc = {};
    const addAd = (month, brand, plat, name, spend, impr, reach, lc, clk, hasReach) => {
      const key = month+'|'+brand+'|'+plat+'|'+name;
      const a = adAcc[key] || (adAcc[key] = { month, brand, plat, name, spend:0, impressions:0, reach:0, link_clicks:0, clicks:0, hasReach });
      a.spend+=spend; a.impressions+=impr; a.reach+=reach; a.link_clicks+=lc; a.clicks+=clk;
    };
    const adAll = await win('facebook', ['account_id','year','month','campaign','adset_name','spend','impressions','reach','link_clicks','clicks'], {account:FB_ACCT, from:MONTH_FROM});
    adAll.filter(r => String(r.account_id) === FB_ACCT).forEach(r => {
      const m = ymOf(r); if (!/^202[56]/.test(m)) return;
      addAd(m, productOf(r.campaign), /traffic/i.test(r.campaign)?'Traffic':'Awareness', cleanMeta(r.adset_name||'—'), +r.spend||0, +r.impressions||0, +r.reach||0, +r.link_clicks||0, +r.clicks||0, true);
    });
    tCr.filter(r => String(r.account_id) === TT_ACCT).forEach(r => {   // TikTok ads (sin reach)
      const m = ymOf(r); if (!/^202[56]/.test(m)) return;
      addAd(m, productOf(r.campaign), 'TikTok', cleanTT(r.ad_name||'—'), (+r.spend||0)*RATE, +r.impressions||0, 0, +r.clicks||0, +r.clicks||0, false);
    });
    const freshAd = {};
    Object.values(adAcc).forEach(a => {
      a.ctr = a.impressions?+(a.clicks/a.impressions*100).toFixed(2):0;
      const M=freshAd[a.month]||(freshAd[a.month]={}), B=M[a.brand]||(M[a.brand]={});
      (B[a.plat]||(B[a.plat]=[])).push({name:a.name,impressions:a.impressions,link_clicks:a.link_clicks,reach:a.reach,clicks:a.clicks,ctr:a.ctr,hasReach:a.hasReach});
    });
    for(const m in freshAd) for(const b in freshAd[m]) for(const p in freshAd[m][b])
      freshAd[m][b][p] = freshAd[m][b][p].sort((x,y)=>y.impressions-x.impressions).slice(0, 12);
    // fusión: base = meses previos guardados; se sobreescriben solo los meses recientes re-pulled
    const adPrev = (readJson(path.join(dataDir,'adsets.json'))||{}).months || {};
    const adMonths = JSON.parse(JSON.stringify(adPrev));
    for(const m in freshAd) adMonths[m] = freshAd[m];
    if (!ttOk) { // preservar ads TikTok previos en los meses re-escritos
      for(const m in adPrev) for(const b in adPrev[m]) if(adPrev[m][b].TikTok){
        (adMonths[m]=adMonths[m]||{}); (adMonths[m][b]=adMonths[m][b]||{}); adMonths[m][b].TikTok = adPrev[m][b].TikTok;
      }
    }
    adMonthsCount = Object.keys(adMonths).length;
    fs.writeFileSync(path.join(dataDir,'adsets.json'), JSON.stringify({ source:'Meta adsets + TikTok ads', updated:new Date().toISOString(), months:adMonths }, null, 2));
  } catch(e){ warns.push('Adsets no actualizados (se conserva lo previo): '+String(e.message||e).slice(0,100)); }

  console.log(`OK · meta ${metaRows.length} · tiktok ${ttOk?ttRows.length:'(preservado)'} · adsets ${adMonthsCount} meses`);
  if (warns.length) { console.log('\nAVISOS:'); warns.forEach(w=>console.log(' - '+w)); }
})().catch(e => { console.error(e); process.exit(1); });
