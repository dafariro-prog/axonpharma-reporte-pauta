#!/usr/bin/env node
/**
 * Refresca la data del reporte de pauta Axon Pharma desde Windsor.ai:
 *   - data/meta.json      (Meta Ads, cuenta 1211531357024604)
 *   - data/tiktok.json    (TikTok Ads, cuenta 7512240273293279239, USD->COP)
 *   - data/creatives.json (creativos reales: Meta image_url + TikTok video_thumbnail_url)
 *
 * data/google_ads.json (Google Search, BigQuery) NO se toca: es snapshot histórico.
 *
 * Requiere Node 18+ y WINDSOR_API_KEY. Solo procesa meses de 2026.
 * Uso: WINDSOR_API_KEY=xxxx node refresh.js
 */
const fs = require('fs');
const path = require('path');

const RAW_KEY  = (process.env.WINDSOR_API_KEY || '').trim();
const API_KEY  = (RAW_KEY.match(/api_key=([^&\s]+)/i)?.[1] || RAW_KEY).trim();
const FB_ACCT  = '1211531357024604';
const TT_ACCT  = '7512240273293279239';
const RATE     = 3800;                 // USD -> COP (TikTok)
const FROM     = '2026-01-01';
const TO       = new Date().toISOString().slice(0, 10);
const TOP_ADS  = 6;

if (!API_KEY) { console.error('ERROR: falta WINDSOR_API_KEY'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const normMonth = m => { m = String(m).trim(); if (/^\d{4}-\d{2}/.test(m)) return m.slice(0,7); if (/^\d{1,2}$/.test(m)) return '2026-'+pad(m); return m; };
const https = u => String(u||'').replace(/^http:\/\//, 'https://');
const PRODUCTS = ['A-CERUMEN','MARIMER&FLORATIL','MARIMER','FLORATIL'];
const productOf = c => { const u=(c||'').toUpperCase(); for(const p of PRODUCTS) if(u.includes(p)) return p==='MARIMER&FLORATIL'?'MARIMER & FLORATIL':p; return 'Otros'; };

async function win(connector, fields, { from=FROM, to=TO } = {}) {
  const url = `https://connectors.windsor.ai/${connector}?` + new URLSearchParams({
    api_key: API_KEY, date_from: from, date_to: to, fields: fields.join(','),
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${connector} API HTTP ${res.status} :: ${(await res.text()).slice(0,150)}`);
  const j = await res.json();
  return (j.data || j.result || []);
}

(async () => {
  const dataDir = path.join(__dirname, 'data');

  // ---------- META (diario) ----------
  const mAll = await win('facebook', ['account_id','campaign','objective','date','spend','impressions',
    'reach','frequency','clicks','link_clicks','cpc','cpm','ctr']);
  const metaRows = mAll.filter(r => String(r.account_id) === FB_ACCT).map(r => ({
    campaign:r.campaign, objective:r.objective, date:r.date,
    spend:+r.spend||0, impressions:+r.impressions||0, reach:+r.reach||0, frequency:+r.frequency||0,
    clicks:+r.clicks||0, link_clicks:+r.link_clicks||0, cpc:+r.cpc||0, cpm:+r.cpm||0, ctr:+r.ctr||0,
  })).filter(r => r.date && r.impressions > 0).sort((a,b)=> a.date<b.date?-1:1);
  fs.writeFileSync(path.join(dataDir,'meta.json'), JSON.stringify({
    updated:new Date().toISOString(), account:{id:FB_ACCT,name:'Axon Pharma Colombia',connector:'facebook',currency:'COP'}, rows:metaRows }, null, 2));

  // ---------- TIKTOK (diario, USD->COP) ----------
  const tAll = await win('tiktok', ['account_id','campaign','date','spend','impressions','reach',
    'clicks','video_views','cpc','cpm','ctr','frequency']);
  const ttRows = tAll.filter(r => String(r.account_id) === TT_ACCT).map(r => {
    const spend = Math.round((+r.spend||0)*RATE), impressions=+r.impressions||0, clicks=+r.clicks||0;
    return { campaign:r.campaign, objective:/awareness|awarenes/i.test(r.campaign)?'OUTCOME_AWARENESS':'LINK_CLICKS',
      date:r.date, spend, impressions, reach:+r.reach||0, frequency:+r.frequency||0,
      clicks, link_clicks:clicks, views:+r.video_views||0,
      cpc:clicks?+(spend/clicks).toFixed(2):0, cpm:impressions?+(spend/impressions*1000).toFixed(2):0,
      ctr:impressions?+(clicks/impressions*100).toFixed(4):0 };
  }).filter(r => r.date && r.spend > 0).sort((a,b)=> a.date<b.date?-1:1);
  fs.writeFileSync(path.join(dataDir,'tiktok.json'), JSON.stringify({
    updated:new Date().toISOString(), account:{id:TT_ACCT,name:'CO_AxonPharma_GarnierCOLOMBIA',currency:'COP',note:'USD->COP TC 3.800'}, rows:ttRows }, null, 2));

  // ---------- CREATIVOS (Meta image_url + TikTok video_thumbnail_url) ----------
  const acc = {};
  const addCr = (month, brand, plat, ad, img, spend, impr, clk) => {
    if (!/^http/.test(img||'')) return;
    const key = month+'|'+brand+'|'+plat+'|'+ad;
    const a = acc[key] || (acc[key] = { month, brand, plat, ad_name:ad, thumbnail:https(img), spend:0, impressions:0, clicks:0 });
    a.thumbnail = https(img); a.spend += spend; a.impressions += impr; a.clicks += clk;
  };
  const mCr = await win('facebook', ['account_id','month','campaign','ad_name','image_url','thumbnail_url','spend','impressions','clicks']);
  mCr.filter(r => String(r.account_id) === FB_ACCT).forEach(r => {
    const m = normMonth(r.month); if (!m.startsWith('2026')) return;
    const img = /^http/.test(r.image_url||'') ? r.image_url : r.thumbnail_url;   // image_url = creativo real
    addCr(m, productOf(r.campaign), /traffic/i.test(r.campaign)?'Traffic':'Awareness', r.ad_name, img, +r.spend||0, +r.impressions||0, +r.clicks||0);
  });
  const tCr = await win('tiktok', ['account_id','month','campaign','ad_name','video_thumbnail_url','spend','impressions','clicks']);
  tCr.filter(r => String(r.account_id) === TT_ACCT).forEach(r => {
    const m = normMonth(r.month); if (!m.startsWith('2026')) return;
    addCr(m, productOf(r.campaign), 'TikTok', r.ad_name, r.video_thumbnail_url, (+r.spend||0)*RATE, +r.impressions||0, +r.clicks||0);
  });
  const months = {};
  Object.values(acc).forEach(a => {
    a.cpm=a.impressions?+(a.spend/a.impressions*1000).toFixed(2):0;
    a.cpc=a.clicks?+(a.spend/a.clicks).toFixed(2):0;
    a.ctr=a.impressions?+(a.clicks/a.impressions*100).toFixed(2):0;
    const M=months[a.month]||(months[a.month]={}), B=M[a.brand]||(M[a.brand]={});
    (B[a.plat]||(B[a.plat]=[])).push({thumbnail:a.thumbnail,ad_name:a.ad_name,spend:Math.round(a.spend),impressions:a.impressions,clicks:a.clicks,cpm:a.cpm,cpc:a.cpc,ctr:a.ctr});
  });
  for(const m in months) for(const b in months[m]) for(const p in months[m][b])
    months[m][b][p] = months[m][b][p].sort((x,y)=>y.ctr-x.ctr).slice(0, TOP_ADS);
  fs.writeFileSync(path.join(dataDir,'creatives.json'), JSON.stringify({ source:'Meta(image_url)+TikTok', updated:new Date().toISOString(), months }, null, 2));

  // ---------- ADSETS (tabla resumen por conjunto de anuncios) ----------
  const adAcc = {};
  const adAll = await win('facebook', ['account_id','month','campaign','adset_name','spend','impressions','reach','link_clicks','clicks']);
  adAll.filter(r => String(r.account_id) === FB_ACCT).forEach(r => {
    const m = normMonth(r.month); if (!m.startsWith('2026')) return;
    const b = productOf(r.campaign), p = /traffic/i.test(r.campaign)?'Traffic':'Awareness', name=(r.adset_name||'—').trim();
    const key = m+'|'+b+'|'+p+'|'+name;
    const a = adAcc[key] || (adAcc[key] = { month:m, brand:b, plat:p, name, spend:0, impressions:0, reach:0, link_clicks:0, clicks:0 });
    a.spend+=+r.spend||0; a.impressions+=+r.impressions||0; a.reach+=+r.reach||0; a.link_clicks+=+r.link_clicks||0; a.clicks+=+r.clicks||0;
  });
  const adMonths = {};
  Object.values(adAcc).forEach(a => {
    a.ctr = a.impressions?+(a.clicks/a.impressions*100).toFixed(2):0;
    const M=adMonths[a.month]||(adMonths[a.month]={}), B=M[a.brand]||(M[a.brand]={});
    (B[a.plat]||(B[a.plat]=[])).push({name:a.name,impressions:a.impressions,link_clicks:a.link_clicks,reach:a.reach,clicks:a.clicks,ctr:a.ctr,spend:Math.round(a.spend)});
  });
  for(const m in adMonths) for(const b in adMonths[m]) for(const p in adMonths[m][b])
    adMonths[m][b][p] = adMonths[m][b][p].sort((x,y)=>y.impressions-x.impressions);
  fs.writeFileSync(path.join(dataDir,'adsets.json'), JSON.stringify({ source:'Meta adsets', updated:new Date().toISOString(), months:adMonths }, null, 2));

  console.log(`OK · meta ${metaRows.length} · tiktok ${ttRows.length} · creativos ${Object.keys(months).length} meses · adsets ${Object.keys(adMonths).length} meses`);
})().catch(e => { console.error(e); process.exit(1); });
