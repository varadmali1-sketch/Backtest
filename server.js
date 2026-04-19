// ═══════════════════════════════════════════════════════════════════
//  OPTION CHAIN ANALYZER v2 — GOD LEVEL PRO
//  Nifty · BankNifty · Sensex · Live NSE Data
//  12-Factor Signal Engine · Overnight Recommendation · Gamma Column
//  Strike Price Recommendation · Carry or Square Off
//  BUILD: npm install  |  START: node server.js
// ═══════════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 10000;

let analyzed = null, lastFetch = '—', fetchCount = 0;
let isFetching = false, fetchError = null;
let symbol = 'NIFTY';
let nseSessionCookies = '', cookieExpiry = 0;
// History for trend detection (last 5 snapshots)
let history = []; // [{timestamp, spot, pcrOI, ceOI, peOI, totalCEOIChg, totalPEOIChg}]

// ── NSE SESSION COOKIES ──────────────────────────────────────────
async function getNSECookies() {
  if (nseSessionCookies && Date.now() < cookieExpiry) return nseSessionCookies;
  return new Promise(resolve => {
    const req = https.request({
      hostname:'www.nseindia.com', path:'/', method:'GET',
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.5','Connection':'keep-alive'},
      timeout:10000
    }, r=>{
      nseSessionCookies=(r.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
      cookieExpiry=Date.now()+600000;
      let d=''; r.on('data',x=>d+=x); r.on('end',()=>resolve(nseSessionCookies));
    });
    req.on('error',()=>resolve('')); req.on('timeout',()=>{req.destroy();resolve('');});
    req.end();
  });
}

// ── FETCH NSE CHAIN ──────────────────────────────────────────────
async function fetchChain(sym) {
  // SENSEX uses BSE API path
  if(sym==='SENSEX') return fetchSensex();
  const cookies = await getNSECookies();
  return new Promise((resolve,reject)=>{
    const req = https.request({
      hostname:'www.nseindia.com',
      path:`/api/option-chain-indices?symbol=${sym}`,
      method:'GET',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept':'application/json, */*','Accept-Language':'en-US,en;q=0.9',
        'Referer':'https://www.nseindia.com/option-chain',
        'Cookie':cookies,'X-Requested-With':'XMLHttpRequest','Connection':'keep-alive',
      },
      timeout:12000
    }, r=>{
      const chunks=[]; r.on('data',x=>chunks.push(x));
      r.on('end',()=>{
        try{
          const j=JSON.parse(Buffer.concat(chunks).toString());
          if(j?.records?.data) resolve(j); else reject(new Error('Invalid NSE response'));
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject); req.on('timeout',()=>{req.destroy();reject(new Error('NSE timeout'));});
    req.end();
  });
}

// Sensex option chain via NSE (SENSEX is also on NSE FnO)
async function fetchSensex() {
  const cookies = await getNSECookies();
  return new Promise((resolve,reject)=>{
    const req = https.request({
      hostname:'www.nseindia.com',
      path:`/api/option-chain-indices?symbol=SENSEX`,
      method:'GET',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept':'application/json, */*','Referer':'https://www.nseindia.com/option-chain',
        'Cookie':cookies,'X-Requested-With':'XMLHttpRequest',
      },
      timeout:12000
    }, r=>{
      const chunks=[]; r.on('data',x=>chunks.push(x));
      r.on('end',()=>{
        try{
          const j=JSON.parse(Buffer.concat(chunks).toString());
          if(j?.records?.data) resolve(j); else reject(new Error('No SENSEX data'));
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject); req.on('timeout',()=>{req.destroy();reject(new Error('Sensex timeout'));});
    req.end();
  });
}

// ── BLACK-SCHOLES GREEKS ─────────────────────────────────────────
function normCDF(x){
  const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
  const s=x<0?-1:1; x=Math.abs(x);
  const t=1/(1+p*x);
  return 0.5*(1+s*(1-(((((a[4]*t+a[3])*t)+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));
}
function normPDF(x){return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);}

function bs(S,K,T,r,sigma,isCall){
  if(T<=0||sigma<=0) return{price:Math.max(0,isCall?S-K:K-S),delta:isCall?1:0,gamma:0,theta:0,vega:0,rho:0};
  const d1=(Math.log(S/K)+(r+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  const sqT=Math.sqrt(T), expRT=Math.exp(-r*T);
  const Nd1=normCDF(d1), Nd2=normCDF(d2), nd1=normPDF(d1);
  const price=isCall?S*Nd1-K*expRT*Nd2:K*expRT*normCDF(-d2)-S*normCDF(-d1);
  const delta=isCall?Nd1:Nd1-1;
  const gamma=nd1/(S*sigma*sqT);
  const theta=(-S*nd1*sigma/(2*sqT)-(isCall?1:-1)*r*K*expRT*normCDF((isCall?1:-1)*d2))/365;
  const vega=S*nd1*sqT/100;
  const rho=(isCall?K*T*expRT*Nd2:-K*T*expRT*normCDF(-d2))/100;
  return{price:Math.max(0,+price.toFixed(2)),delta:+delta.toFixed(4),gamma:+gamma.toFixed(6),theta:+theta.toFixed(4),vega:+vega.toFixed(4),rho:+rho.toFixed(4)};
}

function calcIV(price,S,K,T,r,isCall,init=0.3){
  if(T<=0||price<=0) return 0;
  let sigma=init;
  for(let i=0;i<100;i++){
    const g=bs(S,K,T,r,sigma,isCall);
    const diff=g.price-price;
    if(Math.abs(diff)<0.001) return sigma;
    const v=g.vega*100; if(Math.abs(v)<0.00001) break;
    sigma-=diff/v; if(sigma<=0)sigma=0.001; if(sigma>5)sigma=5;
  }
  return sigma;
}

// ── IST HELPERS ──────────────────────────────────────────────────
function istNow(){return new Date(Date.now()+19800000);}
function tIST(){const t=istNow();return t.getUTCHours()*60+t.getUTCMinutes();}
function isMarketOpen(){
  const t=istNow(),d=t.getUTCDay(),m=t.getUTCHours()*60+t.getUTCMinutes();
  return d>=1&&d<=5&&m>=555&&m<=930;
}
function daysToExpiry(expiryDate){
  const exp=new Date(expiryDate); exp.setHours(15,30,0,0);
  return Math.max(0,(exp-istNow())/(1000*60*60*24));
}

// ── ANALYZE CHAIN ────────────────────────────────────────────────
function analyzeChain(raw, sym) {
  const records = raw.records;
  const spot = records.underlyingValue;
  const expiries = [...new Set(records.data.map(d=>d.expiryDate))].sort();
  const nearExpiry = expiries[0];
  const nextExpiry = expiries[1]||null;

  const T   = daysToExpiry(nearExpiry)/365;
  const Tnext = nextExpiry ? daysToExpiry(nextExpiry)/365 : T+7/365;
  const r   = 0.065;
  const step = sym==='NIFTY'?50:100;
  const atmStrike = Math.round(spot/step)*step;
  const strikes = [];
  for(let i=-15;i<=15;i++) strikes.push(atmStrike+i*step);

  const dataMap = {};
  records.data.filter(d=>d.expiryDate===nearExpiry).forEach(d=>{
    if(!dataMap[d.strikePrice]) dataMap[d.strikePrice]={};
    if(d.CE) dataMap[d.strikePrice].ce=d.CE;
    if(d.PE) dataMap[d.strikePrice].pe=d.PE;
  });

  const rows = [];
  let totCEOI=0,totPEOI=0,totCEVol=0,totPEVol=0,totCEChg=0,totPEChg=0;

  strikes.forEach(K=>{
    const d=dataMap[K]||{}, ce=d.ce||{}, pe=d.pe||{};
    const ceLTP=ce.lastPrice||0, peLTP=pe.lastPrice||0;
    const ceOI=ce.openInterest||0, peOI=pe.openInterest||0;
    const ceOIChg=ce.changeinOpenInterest||0, peOIChg=pe.changeinOpenInterest||0;
    const ceVol=ce.totalTradedVolume||0, peVol=pe.totalTradedVolume||0;
    const ceIVraw=(ce.impliedVolatility||0)/100;
    const peIVraw=(pe.impliedVolatility||0)/100;
    const ceIV=ceIVraw>0?ceIVraw:(ceLTP>0?calcIV(ceLTP,spot,K,T,r,true):0.15);
    const peIV=peIVraw>0?peIVraw:(peLTP>0?calcIV(peLTP,spot,K,T,r,false):0.15);
    const ceG=ceLTP>0?bs(spot,K,T,r,ceIV,true):{delta:0,gamma:0,theta:0,vega:0,rho:0};
    const peG=peLTP>0?bs(spot,K,T,r,peIV,false):{delta:0,gamma:0,theta:0,vega:0,rho:0};

    // Bid-ask spread quality (tight = liquid, wide = illiquid)
    const ceBidAsk=ce.askPrice&&ce.bidprice?+(ce.askPrice-ce.bidprice).toFixed(1):null;
    const peBidAsk=pe.askPrice&&pe.bidprice?+(pe.askPrice-pe.bidprice).toFixed(1):null;

    // OI action interpretation
    const prevCE=ce.previousClose||ceLTP;
    const prevPE=pe.previousClose||peLTP;
    const ceAction=ceOIChg>0?(ceLTP>=prevCE?'LNG_BLD':'SHT_BLD'):(ceOIChg<0?'UNWIND':'—');
    const peAction=peOIChg>0?(peLTP>=prevPE?'LNG_BLD':'SHT_BLD'):(peOIChg<0?'UNWIND':'—');

    totCEOI+=ceOI; totPEOI+=peOI; totCEVol+=ceVol; totPEVol+=peVol;
    totCEChg+=ceOIChg; totPEChg+=peOIChg;

    rows.push({
      strike:K, isATM:K===atmStrike, moneyness:+((spot-K)/spot*100).toFixed(2),
      ce:{ltp:ceLTP,oi:ceOI,oiChg:ceOIChg,vol:ceVol,iv:+(ceIV*100).toFixed(1),
          delta:ceG.delta,gamma:ceG.gamma,theta:ceG.theta,vega:ceG.vega,rho:ceG.rho,
          action:ceAction,bid:ce.bidprice||0,ask:ce.askPrice||0,spread:ceBidAsk,
          prevClose:prevCE},
      pe:{ltp:peLTP,oi:peOI,oiChg:peOIChg,vol:peVol,iv:+(peIV*100).toFixed(1),
          delta:peG.delta,gamma:peG.gamma,theta:peG.theta,vega:peG.vega,rho:peG.rho,
          action:peAction,bid:pe.bidprice||0,ask:pe.askPrice||0,spread:peBidAsk,
          prevClose:prevPE},
    });
  });

  // ── MAX PAIN ─────────────────────────────────────────────────────
  let maxPain=atmStrike, minP=Infinity;
  rows.forEach(r2=>{
    let p=0;
    rows.forEach(r3=>{p+=r3.ce.oi*Math.max(0,r3.strike-r2.strike)+r3.pe.oi*Math.max(0,r2.strike-r3.strike);});
    if(p<minP){minP=p;maxPain=r2.strike;}
  });

  // ── PCR ──────────────────────────────────────────────────────────
  const pcrOI=totCEOI>0?+(totPEOI/totCEOI).toFixed(2):0;
  const pcrVol=totCEVol>0?+(totPEVol/totCEVol).toFixed(2):0;

  // ── IV SURFACE ANALYSIS ──────────────────────────────────────────
  const atmRow=rows.find(r=>r.strike===atmStrike)||rows[Math.floor(rows.length/2)];
  const otmCE2=rows.find(r=>r.strike===atmStrike+step*2);
  const otmPE2=rows.find(r=>r.strike===atmStrike-step*2);
  const otmCE4=rows.find(r=>r.strike===atmStrike+step*4);
  const otmPE4=rows.find(r=>r.strike===atmStrike-step*4);
  const ivSkew=otmPE2&&otmCE2?+(otmPE2.pe.iv-otmCE2.ce.iv).toFixed(2):0;
  const ivWing=otmPE4&&otmCE4?+(((otmPE4.pe.iv+otmCE4.ce.iv)/2)-parseFloat(atmRow.ce.iv||atmRow.pe.iv||15)).toFixed(2):0;
  const atmIVnum=atmRow?+(((parseFloat(atmRow.ce.iv)||0)+(parseFloat(atmRow.pe.iv)||0))/2):15;
  const atmIV=atmIVnum.toFixed(1);

  // ── SUPPORT / RESISTANCE ─────────────────────────────────────────
  const sortPE=[...rows].filter(r=>r.pe.oi>0).sort((a,b)=>b.pe.oi-a.pe.oi);
  const sortCE=[...rows].filter(r=>r.ce.oi>0).sort((a,b)=>b.ce.oi-a.ce.oi);
  const sup1=sortPE[0]?.strike||0, sup2=sortPE[1]?.strike||0;
  const res1=sortCE[0]?.strike||0, res2=sortCE[1]?.strike||0;

  // ── OI TREND HISTORY ─────────────────────────────────────────────
  history.push({ts:Date.now(),spot,pcrOI,ceOI:totCEOI,peOI:totPEOI,ceChg:totCEChg,peChg:totPEChg});
  if(history.length>10) history.shift();
  const pcrTrend=history.length>=3?
    (history[history.length-1].pcrOI>history[history.length-3].pcrOI?'RISING':'FALLING'):'—';
  const spotTrend=history.length>=3?
    (history[history.length-1].spot>history[history.length-3].spot?'UP':'DOWN'):'—';

  // ── FII / RETAIL PROXY ───────────────────────────────────────────
  const farRows=rows.filter(r=>Math.abs(r.strike-spot)>step*6);
  const nearRows=rows.filter(r=>Math.abs(r.strike-spot)<=step*3);
  const fiiCE=farRows.reduce((s,r)=>s+r.ce.oi,0);
  const fiiPE=farRows.reduce((s,r)=>s+r.pe.oi,0);
  const retCE=nearRows.reduce((s,r)=>s+r.ce.oi,0);
  const retPE=nearRows.reduce((s,r)=>s+r.pe.oi,0);
  const fiiBias=fiiPE>fiiCE*1.3?'BEARISH':fiiCE>fiiPE*1.3?'BULLISH':'NEUTRAL';
  const retBias=retPE>retCE*1.2?'LONG PUTS':retCE>retPE*1.2?'LONG CALLS':'MIXED';

  // ── GAMMA EXPOSURE (GEX) ─────────────────────────────────────────
  // Net dealer gamma exposure — if negative = dealers short gamma = volatile
  let gex=0;
  rows.forEach(r=>{
    gex+=r.ce.gamma*r.ce.oi*spot*0.01; // CE: dealers short
    gex-=r.pe.gamma*r.pe.oi*spot*0.01; // PE: dealers long
  });
  const gexSign=gex>0?'POSITIVE (stable)':'NEGATIVE (volatile)';

  // ── 12-FACTOR SIGNAL ENGINE ──────────────────────────────────────
  const signals=[];
  let bull=0, bear=0;

  // Factor 1: PCR OI (weight 18)
  if(pcrOI>=1.5){bull+=18;signals.push({t:'BULL',src:'PCR OI',w:18,msg:`PCR OI ${pcrOI} ≥1.5 — Strong put writing. Bulls supported.`});}
  else if(pcrOI>=1.2){bull+=10;signals.push({t:'BULL',src:'PCR OI',w:10,msg:`PCR OI ${pcrOI} = mildly bullish. More put writers than call writers.`});}
  else if(pcrOI<=0.7){bear+=18;signals.push({t:'BEAR',src:'PCR OI',w:18,msg:`PCR OI ${pcrOI} ≤0.7 — Aggressive call writing. Bears dominate.`});}
  else if(pcrOI<=0.9){bear+=10;signals.push({t:'BEAR',src:'PCR OI',w:10,msg:`PCR OI ${pcrOI} = mildly bearish. More call writers than put writers.`});}
  else signals.push({t:'NEUT',src:'PCR OI',w:0,msg:`PCR OI ${pcrOI} neutral (0.9–1.2). No clear directional bias.`});

  // Factor 2: PCR Volume (weight 10)
  if(pcrVol>=1.3){bull+=10;signals.push({t:'BULL',src:'PCR Vol',w:10,msg:`PCR Vol ${pcrVol} — Intraday put buying confirms bullish sentiment.`});}
  else if(pcrVol<=0.8){bear+=10;signals.push({t:'BEAR',src:'PCR Vol',w:10,msg:`PCR Vol ${pcrVol} — Intraday call buying reflects bearish expectations.`});}

  // Factor 3: Max Pain (weight 15)
  const mpDist=spot-maxPain;
  if(mpDist>step*3){bear+=15;signals.push({t:'BEAR',src:'Max Pain',w:15,msg:`Spot (${spot}) ${mpDist}pts ABOVE max pain (${maxPain}). Expiry gravity pulls down.`});}
  else if(mpDist<-step*3){bull+=15;signals.push({t:'BULL',src:'Max Pain',w:15,msg:`Spot (${spot}) ${Math.abs(mpDist)}pts BELOW max pain (${maxPain}). Expiry gravity pulls up.`});}
  else signals.push({t:'NEUT',src:'Max Pain',w:0,msg:`Spot near max pain ${maxPain} — range-bound expected into expiry.`});

  // Factor 4: IV Skew (weight 12)
  if(ivSkew>=4){bear+=12;signals.push({t:'BEAR',src:'IV Skew',w:12,msg:`Put skew +${ivSkew}% — Smart money buying protective puts. Fear elevated.`});}
  else if(ivSkew>=2){bear+=6;signals.push({t:'BEAR',src:'IV Skew',w:6,msg:`Mild put skew +${ivSkew}% — slight downside hedging.`});}
  else if(ivSkew<=-4){bull+=12;signals.push({t:'BULL',src:'IV Skew',w:12,msg:`Call skew ${ivSkew}% — Institutions paying up for calls. Bullish expectation.`});}
  else if(ivSkew<=-2){bull+=6;signals.push({t:'BULL',src:'IV Skew',w:6,msg:`Mild call skew ${ivSkew}% — slight upside positioning.`});}
  else signals.push({t:'NEUT',src:'IV Skew',w:0,msg:`IV Skew ${ivSkew}% balanced. No directional premium bias.`});

  // Factor 5: Resistance wall (weight 18)
  if(res1>0){
    const d=res1-spot;
    if(d>0&&d<=step){bear+=18;signals.push({t:'BEAR',src:'CE Wall',w:18,msg:`⚠️ Massive CE OI wall at ${res1} — only ${d}pts away. Very strong resistance. Likely reversal zone.`});}
    else if(d>0&&d<=step*3){bear+=10;signals.push({t:'BEAR',src:'CE Wall',w:10,msg:`CE OI wall at ${res1} (${d}pts). Resistance. Upside limited unless wall breaks.`});}
    else if(d<=0){bull+=20;signals.push({t:'BULL',src:'CE Break',w:20,msg:`🚀 Spot ABOVE CE OI wall ${res1}! Bullish breakout confirmed. Wall became support.`});}
  }

  // Factor 6: Support wall (weight 18)
  if(sup1>0){
    const d=spot-sup1;
    if(d>0&&d<=step){bull+=18;signals.push({t:'BULL',src:'PE Wall',w:18,msg:`⚠️ Massive PE OI support at ${sup1} — only ${d}pts away. Strong support. Buy zone.`});}
    else if(d>0&&d<=step*3){bull+=10;signals.push({t:'BULL',src:'PE Wall',w:10,msg:`PE OI support at ${sup1} (${d}pts below). Solid floor. Downside limited.`});}
    else if(d<=0){bear+=20;signals.push({t:'BEAR',src:'PE Break',w:20,msg:`🔻 Spot BELOW PE support ${sup1}! Bearish breakdown confirmed. Support became resistance.`});}
  }

  // Factor 7: OI Buildup trend (weight 10)
  if(totCEChg>0&&totPEChg>0){
    if(totCEChg>totPEChg*1.5){bear+=10;signals.push({t:'BEAR',src:'OI Build',w:10,msg:`CE OI adding ${((totCEChg/totCEOI)*100).toFixed(1)}% faster than PE. Call writers building resistance.`});}
    else if(totPEChg>totCEChg*1.5){bull+=10;signals.push({t:'BULL',src:'OI Build',w:10,msg:`PE OI adding ${((totPEChg/totPEOI)*100).toFixed(1)}% faster than CE. Put writers building support.`});}
  } else if(totCEChg<0&&totPEChg>0){
    bull+=8;signals.push({t:'BULL',src:'OI Build',w:8,msg:`CE OI unwinding + PE OI adding. Call writers exiting = bullish shift.`});
  } else if(totPEChg<0&&totCEChg>0){
    bear+=8;signals.push({t:'BEAR',src:'OI Build',w:8,msg:`PE OI unwinding + CE OI adding. Put writers exiting = bearish shift.`});
  }

  // Factor 8: FII proxy (weight 15)
  if(fiiBias==='BULLISH'){bull+=15;signals.push({t:'BULL',src:'FII Proxy',w:15,msg:`FII proxy BULLISH — institutional money positioned long (far-OTM CE OI dominant).`});}
  else if(fiiBias==='BEARISH'){bear+=15;signals.push({t:'BEAR',src:'FII Proxy',w:15,msg:`FII proxy BEARISH — institutions buying protective puts (far-OTM PE OI dominant).`});}
  else signals.push({t:'NEUT',src:'FII Proxy',w:0,msg:`FII proxy NEUTRAL — balanced institutional positioning.`});

  // Factor 9: IV level (weight 8)
  if(atmIVnum<13){bull+=8;signals.push({t:'BULL',src:'IV Level',w:8,msg:`ATM IV ${atmIV}% very low — cheap options, good to buy. Low fear = stable market.`});}
  else if(atmIVnum<16){bull+=4;signals.push({t:'BULL',src:'IV Level',w:4,msg:`ATM IV ${atmIV}% low — reasonably cheap options for buyers.`});}
  else if(atmIVnum>25){bear+=8;signals.push({t:'BEAR',src:'IV Level',w:8,msg:`ATM IV ${atmIV}% high — expensive options. Fear elevated. Prefer sellers.`});}

  // Factor 10: PCR trend (weight 8)
  if(pcrTrend==='RISING'&&spotTrend==='UP'){bull+=8;signals.push({t:'BULL',src:'Trend',w:8,msg:`PCR rising + spot rising = put writers adding as market moves up. Classic bullish.`});}
  else if(pcrTrend==='FALLING'&&spotTrend==='DOWN'){bear+=8;signals.push({t:'BEAR',src:'Trend',w:8,msg:`PCR falling + spot falling = put unwinding, call writers adding. Classic bearish.`});}
  else if(pcrTrend==='RISING'&&spotTrend==='DOWN'){signals.push({t:'NEUT',src:'Trend',w:0,msg:`PCR rising but spot falling — conflicting signals. Smart money vs price action divergence.`});}

  // Factor 11: GEX (weight 6)
  if(gex<0){bear+=6;signals.push({t:'BEAR',src:'GEX',w:6,msg:`Gamma Exposure NEGATIVE — dealers short gamma = amplified moves likely. High volatility risk.`});}
  else{signals.push({t:'NEUT',src:'GEX',w:0,msg:`Gamma Exposure POSITIVE — dealers long gamma = mean-reversion pressure. Market stable.`});}

  // Factor 12: Wing IV (weight 5)
  if(ivWing>5){bear+=5;signals.push({t:'BEAR',src:'Wings',w:5,msg:`Deep OTM wings elevated +${ivWing}% vs ATM. Tail risk being priced. Crash insurance buying.`});}

  // ── SIGNAL SCORES ─────────────────────────────────────────────────
  const total=bull+bear||1;
  const bullPct=Math.round(bull/total*100);
  const bearPct=Math.round(bear/total*100);

  // ── CONFIDENCE TIER ───────────────────────────────────────────────
  const margin=Math.abs(bull-bear);
  const confidence=margin>50?'HIGH':margin>30?'MEDIUM':'LOW';
  const confColor=confidence==='HIGH'?'#00ff88':confidence==='MEDIUM'?'#f4c430':'#ff8c00';

  // ── DETERMINE EXACT STRIKE TO BUY ────────────────────────────────
  let masterSignal, recStrike, recOpt, recPremium, recReason, overnightRec, overnightReason;

  const dte=+(T*365).toFixed(1);
  const isExpiryDay=dte<=1;
  const isNearExpiry=dte<=3;

  if(bull>bear+20) {
    masterSignal='BUY CALL';
    recOpt='CE';
    // Strike selection logic:
    // High confidence + low IV → ATM (max delta leverage)
    // Medium confidence → ATM+1 (slight OTM for lower cost)
    // Near expiry + big move signal → ATM (gamma play)
    if(confidence==='HIGH'&&atmIVnum<18){
      recStrike=atmStrike; // ATM CE for maximum delta
    } else if(confidence==='HIGH'){
      recStrike=atmStrike; // Still ATM but be aware of high premium
    } else {
      recStrike=atmStrike; // Default ATM
    }
    const recRow=rows.find(r=>r.strike===recStrike);
    recPremium=recRow?.ce.ltp||0;
    recReason=`Bull score ${bull} vs Bear ${bear}. `+signals.filter(s=>s.t==='BULL').slice(0,3).map(s=>s.src).join(' + ')+` aligned. Entry: ${recStrike}CE @ ₹${recPremium}.`;
  } else if(bear>bull+20) {
    masterSignal='BUY PUT';
    recOpt='PE';
    recStrike=atmStrike;
    const recRow=rows.find(r=>r.strike===recStrike);
    recPremium=recRow?.pe.ltp||0;
    recReason=`Bear score ${bear} vs Bull ${bull}. `+signals.filter(s=>s.t==='BEAR').slice(0,3).map(s=>s.src).join(' + ')+` aligned. Entry: ${recStrike}PE @ ₹${recPremium}.`;
  } else {
    masterSignal='WAIT';
    recStrike=null; recOpt=null; recPremium=0;
    recReason=`Mixed signals — Bull:${bull} Bear:${bear}. Margin too low (need 20+ gap). No high-confidence trade.`;
  }

  // ── OVERNIGHT CARRY RECOMMENDATION ───────────────────────────────
  // CARRY if: DTE > 3 + not high IV + signal is strong + no event risk
  // SQUARE OFF if: DTE <= 1 (expiry tomorrow), or high IV (theta eats premium), or weak signal
  const ist=istNow();
  const isThursday=ist.getUTCDay()===4;
  const isFriday=ist.getUTCDay()===5;
  const timeNow=tIST();
  const isAfternoon=timeNow>780; // after 1 PM

  if(masterSignal==='WAIT'){
    overnightRec='NO TRADE — DO NOT CARRY';
    overnightReason='No clear signal to carry overnight.';
  } else if(isExpiryDay||isThursday){
    overnightRec='❌ SQUARE OFF — DO NOT CARRY';
    overnightReason='Expiry day or day before expiry. Theta decay accelerates overnight on expiry eve. Mandatory exit before 3:25 PM.';
  } else if(isNearExpiry&&atmIVnum>20){
    overnightRec='❌ SQUARE OFF — RISKY CARRY';
    overnightReason=`Only ${dte} DTE with ATM IV ${atmIV}%. High theta + high IV = expensive overnight carry. Gap risk too high.`;
  } else if(dte>5&&confidence==='HIGH'&&atmIVnum<18){
    overnightRec='✅ CARRY OVERNIGHT — RECOMMENDED';
    overnightReason=`${dte} DTE remaining. ${confidence} confidence signal. ATM IV ${atmIV}% (reasonable). Theta: ~₹${Math.abs(atmRow?.ce.theta||0).toFixed(0)}/day. Carry if global cues are neutral. Set stop at 40% of entry.`;
  } else if(dte>3&&confidence==='HIGH'){
    overnightRec='⚠️ CARRY WITH CAUTION';
    overnightReason=`${dte} DTE. High confidence but IV ${atmIV}% is elevated. Risk: gap open against position. Trail stop tightly. Max risk = 40% of premium.`;
  } else if(dte>3&&confidence==='MEDIUM'){
    overnightRec='⚠️ PARTIAL CARRY — Book 50% intraday';
    overnightReason=`${dte} DTE but ${confidence} confidence. Carry only 50% of position overnight. Book 50% profit before 3:15 PM to protect gains.`;
  } else {
    overnightRec='❌ SQUARE OFF — PREFER INTRADAY EXIT';
    overnightReason=`${dte} DTE with ${confidence} confidence signal. Not worth overnight theta risk. Exit by 3:20 PM.`;
  }

  return {
    spot, sym, expiry:nearExpiry, nextExpiry, dte, T,
    atmStrike, atmIV, atmIVnum, ivSkew, ivWing, gex:+gex.toFixed(0), gexSign,
    pcr:{oi:pcrOI,vol:pcrVol,trend:pcrTrend},
    maxPain, sup1, sup2, res1, res2,
    oi:{ceTot:totCEOI,peTot:totPEOI,ceChg:totCEChg,peChg:totPEChg},
    vol:{ceTot:totCEVol,peTot:totPEVol},
    fii:{bias:fiiBias,cOI:fiiCE,pOI:fiiPE},
    retail:{bias:retBias,cOI:retCE,pOI:retPE},
    signals, bull, bear, bullPct, bearPct,
    masterSignal, recStrike, recOpt, recPremium, recReason, confidence, confColor,
    overnightRec, overnightReason,
    rows, spotTrend, isMarketOpen:isMarketOpen(),
    lastUpdate:ist.toISOString().slice(11,19)+' IST', isDemoData:false
  };
}

// ── SYNTHETIC DATA (market closed / NSE blocked) ─────────────────
function syntheticChain(sym) {
  const spot=sym==='NIFTY'?24350:sym==='BANKNIFTY'?52000:80000;
  const step=sym==='NIFTY'?50:100;
  const atm=Math.round(spot/step)*step;
  const T=4/365,r=0.065,baseIV=0.15;
  const records={underlyingValue:spot,data:[]};
  for(let i=-12;i<=12;i++){
    const K=atm+i*step;
    const ceIV=baseIV+Math.max(0,i)*0.001+0.005;
    const peIV=baseIV+Math.max(0,-i)*0.002+0.008;
    const ceP=bs(spot,K,T,r,ceIV,true);
    const peP=bs(spot,K,T,r,peIV,false);
    const ceOI=Math.round((1-Math.abs(i)/14)*4000000+Math.random()*500000)*(i>=0?1.2:0.8);
    const peOI=Math.round((1-Math.abs(i)/14)*4000000+Math.random()*500000)*(i<=0?1.2:0.8);
    records.data.push({
      expiryDate:'2026-04-24',strikePrice:K,
      CE:{lastPrice:+ceP.price.toFixed(1),openInterest:Math.round(ceOI),changeinOpenInterest:Math.round((Math.random()-0.4)*ceOI*0.08),totalTradedVolume:Math.round(ceOI*0.12),impliedVolatility:+(ceIV*100).toFixed(1),bidprice:+(ceP.price*0.99).toFixed(1),askPrice:+(ceP.price*1.01).toFixed(1)},
      PE:{lastPrice:+peP.price.toFixed(1),openInterest:Math.round(peOI),changeinOpenInterest:Math.round((Math.random()-0.4)*peOI*0.08),totalTradedVolume:Math.round(peOI*0.12),impliedVolatility:+(peIV*100).toFixed(1),bidprice:+(peP.price*0.99).toFixed(1),askPrice:+(peP.price*1.01).toFixed(1)},
    });
  }
  try{const r=analyzeChain({records},sym);r.isDemoData=true;return r;}
  catch(e){return null;}
}

// ── MAIN REFRESH ─────────────────────────────────────────────────
async function refresh() {
  if(isFetching) return;
  isFetching=true; fetchError=null;
  try {
    const raw=await fetchChain(symbol);
    analyzed=analyzeChain(raw,symbol);
    fetchCount++;
    lastFetch=analyzed.lastUpdate;
    console.log(`[${lastFetch}] ${symbol} spot:${analyzed.spot} signal:${analyzed.masterSignal} conf:${analyzed.confidence} bull:${analyzed.bull} bear:${analyzed.bear}`);
  }catch(e){
    fetchError=e.message;
    console.log(`[WARN] NSE fetch failed: ${e.message} — demo mode`);
    const syn=syntheticChain(symbol);
    if(syn){analyzed=syn;lastFetch=istNow().toISOString().slice(11,19)+' IST (DEMO)';}
  }
  isFetching=false;
}

// ── HELPERS ──────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function N(n,dec=0){if(n==null||isNaN(n))return'—';if(Math.abs(n)>=10000000)return(n/10000000).toFixed(2)+'Cr';if(Math.abs(n)>=100000)return(n/100000).toFixed(2)+'L';if(Math.abs(n)>=1000)return(n/1000).toFixed(1)+'K';return dec?n.toFixed(dec):n.toLocaleString('en-IN');}

// ── HTML ─────────────────────────────────────────────────────────
function buildHTML() {
  const a=analyzed;
  if(!a) return`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loading...</title><meta http-equiv="refresh" content="3"></head><body style="background:#020409;color:#dde8ff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px"><div style="font-size:28px;animation:spin 1s linear infinite">⚙</div><div style="font-size:13px">Fetching ${symbol} option chain from NSE...</div><style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style></body></html>`;

  const sc=a.masterSignal.includes('CALL')?'#00ff88':a.masterSignal.includes('PUT')?'#ff3355':'#f4c430';
  const isLive=!a.isDemoData;

  // ── SIGNAL BOX ──────────────────────────────────────────────────
  const sigBox=`
  <div style="background:${sc}0e;border:2px solid ${sc}55;border-radius:14px;padding:14px;margin-bottom:10px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-family:'Bebas Neue',cursive;font-size:24px;letter-spacing:3px;color:${sc}">${esc(a.masterSignal)}</div>
        <div style="font-family:monospace;font-size:8px;padding:2px 8px;border-radius:5px;background:${a.confColor}22;border:1px solid ${a.confColor}55;color:${a.confColor};margin-top:3px;display:inline-block">CONFIDENCE: ${a.confidence}</div>
      </div>
      <div style="text-align:right">
        <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end">
          <div style="text-align:center"><div style="font-family:monospace;font-size:8px;color:#00ff88">BULL</div><div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:700;color:#00ff88">${a.bullPct}%</div></div>
          <div style="font-family:monospace;font-size:12px;color:#253348">|</div>
          <div style="text-align:center"><div style="font-family:monospace;font-size:8px;color:#ff3355">BEAR</div><div style="font-family:'Space Mono',monospace;font-size:18px;font-weight:700;color:#ff3355">${a.bearPct}%</div></div>
        </div>
        <div style="width:130px;height:7px;background:#ff3355;border-radius:4px;overflow:hidden;margin-top:5px">
          <div style="height:100%;width:${a.bullPct}%;background:#00ff88;border-radius:4px;transition:width .5s"></div>
        </div>
      </div>
    </div>
    ${a.recStrike?`
    <div style="background:rgba(0,0,0,.3);border-radius:10px;padding:10px;margin-bottom:8px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:6px">RECOMMENDED TRADE</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
        <div style="background:#020409;border-radius:7px;padding:8px;border:1px solid ${sc}44">
          <div style="font-family:monospace;font-size:7px;color:#5a6f96">STRIKE</div>
          <div style="font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:${sc}">${a.recStrike}</div>
          <div style="font-family:monospace;font-size:9px;color:${sc}">${a.recOpt}</div>
        </div>
        <div style="background:#020409;border-radius:7px;padding:8px;border:1px solid #162030">
          <div style="font-family:monospace;font-size:7px;color:#5a6f96">ENTRY PRICE</div>
          <div style="font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:#f4c430">${a.recPremium>0?'₹'+a.recPremium:'—'}</div>
          <div style="font-family:monospace;font-size:8px;color:#5a6f96">ATM premium</div>
        </div>
        <div style="background:#020409;border-radius:7px;padding:8px;border:1px solid #162030">
          <div style="font-family:monospace;font-size:7px;color:#5a6f96">STOP LOSS</div>
          <div style="font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:#ff3355">${a.recPremium>0?'₹'+Math.round(a.recPremium*0.60):'—'}</div>
          <div style="font-family:monospace;font-size:8px;color:#5a6f96">40% of premium</div>
        </div>
      </div>
    </div>
    `:''}
    <!-- OVERNIGHT CARRY BOX -->
    <div style="background:${a.overnightRec.includes('✅')?'rgba(0,255,136,.06)':a.overnightRec.includes('❌')?'rgba(255,51,85,.06)':'rgba(244,196,48,.06)'};border:1px solid ${a.overnightRec.includes('✅')?'rgba(0,255,136,.3)':a.overnightRec.includes('❌')?'rgba(255,51,85,.3)':'rgba(244,196,48,.3)'};border-radius:9px;padding:10px;margin-bottom:8px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:4px">OVERNIGHT CARRY?</div>
      <div style="font-family:monospace;font-size:11px;font-weight:700;color:${a.overnightRec.includes('✅')?'#00ff88':a.overnightRec.includes('❌')?'#ff3355':'#f4c430'}">${esc(a.overnightRec)}</div>
      <div style="font-family:monospace;font-size:9px;color:#5a6f96;margin-top:4px;line-height:1.6">${esc(a.overnightReason)}</div>
    </div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.6">${esc(a.recReason)}</div>
  </div>`;

  // ── LEVELS ──────────────────────────────────────────────────────
  const levelsBox=`
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:10px">
    ${[['SPOT',a.spot.toLocaleString('en-IN'),'#dde8ff'],['ATM',a.atmStrike,'#00e5ff'],['MAX PAIN',a.maxPain,'#ffe566'],
       ['RESIST 1',a.res1||'—','#ff3355'],['RESIST 2',a.res2||'—','#ff8c00'],['ATM IV',a.atmIV+'%',a.atmIVnum>22?'#ff3355':a.atmIVnum<14?'#00ff88':'#f4c430'],
       ['SUPPORT 1',a.sup1||'—','#00ff88'],['SUPPORT 2',a.sup2||'—','#4dff88'],['IV SKEW',a.ivSkew+'%',a.ivSkew>3?'#ff3355':a.ivSkew<-3?'#00ff88':'#f4c430'],
       ['DTE',a.dte+'d',a.dte<=1?'#ff3355':a.dte<=3?'#f4c430':'#00ff88'],['GEX',N(a.gex),a.gex<0?'#ff3355':'#00ff88'],['EXPIRY',a.expiry?.slice(0,10)||'—','#5a6f96']
      ].map(([l,v,c])=>`<div style="background:#090b15;border:1px solid #162030;border-radius:7px;padding:7px"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:2px">${l}</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
  </div>`;

  // ── PCR + OI ────────────────────────────────────────────────────
  const pcrBox=`
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:7px">PCR</div>
      ${[['OI PCR',a.pcr.oi,a.pcr.oi>=1.3?'🐂 Bullish':a.pcr.oi<=0.8?'🐻 Bearish':'⚖️ Neutral'],
         ['Vol PCR',a.pcr.vol,a.pcr.vol>=1.3?'🐂 Bullish':a.pcr.vol<=0.8?'🐻 Bearish':'⚖️ Neutral'],
         ['PCR Trend',a.pcr.trend,a.pcr.trend==='RISING'?'#00ff88':a.pcr.trend==='FALLING'?'#ff3355':'#5a6f96']
        ].map(([l,v,b])=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #0f1624"><span style="font-family:monospace;font-size:9px;color:#5a6f96">${l}</span><div><span style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${typeof b==='string'&&b.startsWith('#')?b:v>=1.3?'#00ff88':v<=0.8?'#ff3355':'#f4c430'}">${typeof v==='number'?v:v}</span>${typeof b==='string'&&!b.startsWith('#')?`<span style="font-family:monospace;font-size:8px;color:#5a6f96;margin-left:4px">${b}</span>`:''}</div></div>`).join('')}
    </div>
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:7px">OI SUMMARY</div>
      ${[['Total CE',N(a.oi.ceTot),'#ff3355'],['Total PE',N(a.oi.peTot),'#00ff88'],
         ['CE Chg',(a.oi.ceChg>0?'+':'')+N(a.oi.ceChg),a.oi.ceChg>0?'#ff3355':'#00ff88'],
         ['PE Chg',(a.oi.peChg>0?'+':'')+N(a.oi.peChg),a.oi.peChg>0?'#00ff88':'#ff3355']
        ].map(([l,v,c])=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #0f1624"><span style="font-family:monospace;font-size:9px;color:#5a6f96">${l}</span><span style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${c}">${v}</span></div>`).join('')}
    </div>
  </div>`;

  // ── FII + RETAIL ────────────────────────────────────────────────
  const sentBox=`
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
    <div style="background:#090b15;border:1px solid ${a.fii.bias==='BULLISH'?'rgba(0,255,136,.3)':a.fii.bias==='BEARISH'?'rgba(255,51,85,.3)':'#162030'};border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:4px">FII PROXY</div>
      <div style="font-family:monospace;font-size:12px;font-weight:700;color:${a.fii.bias==='BULLISH'?'#00ff88':a.fii.bias==='BEARISH'?'#ff3355':'#f4c430'}">${a.fii.bias==='BULLISH'?'🐂 LONG':a.fii.bias==='BEARISH'?'🐻 SHORT':'⚖️ NEUTRAL'}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:4px">Far CE: ${N(a.fii.cOI)} · Far PE: ${N(a.fii.pOI)}</div>
    </div>
    <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px">
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:4px">RETAIL</div>
      <div style="font-family:monospace;font-size:12px;font-weight:700;color:#f4c430">${esc(a.retail.bias)}</div>
      <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:4px">Near CE: ${N(a.retail.cOI)} · Near PE: ${N(a.retail.pOI)}</div>
    </div>
  </div>`;

  // ── 12-FACTOR SIGNALS ───────────────────────────────────────────
  const sigList=`
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:10px">
    <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">12-FACTOR SIGNAL BREAKDOWN</div>
    ${a.signals.map(s=>{
      const c=s.t==='BULL'?'#00ff88':s.t==='BEAR'?'#ff3355':'#f4c430';
      const ic=s.t==='BULL'?'▲':s.t==='BEAR'?'▼':'●';
      return`<div style="display:flex;gap:7px;padding:5px 0;border-bottom:1px solid #0a0f1a">
        <div style="color:${c};font-size:10px;flex-shrink:0;width:12px;margin-top:1px">${ic}</div>
        <div style="flex:1"><div style="font-family:monospace;font-size:8px;color:${c};font-weight:700">${s.src}${s.w>0?' (+'+s.w+')':''}</div><div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:1px;line-height:1.5">${esc(s.msg)}</div></div>
      </div>`;
    }).join('')}
  </div>`;

  // ── OI BAR CHART ────────────────────────────────────────────────
  const maxOI=Math.max(...a.rows.map(r=>Math.max(r.ce.oi,r.pe.oi)),1);
  const oiChart=`
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:10px;overflow-x:auto">
    <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">OI DISTRIBUTION — Green=PE (support), Red=CE (resistance)</div>
    <div style="min-width:300px">
      ${[...a.rows].reverse().map(r=>{
        const cw=Math.round(r.ce.oi/maxOI*100);
        const pw=Math.round(r.pe.oi/maxOI*100);
        const iS=r.strike===a.sup1, iR=r.strike===a.res1, iMP=r.strike===a.maxPain, isA=r.isATM;
        const lbl=isA?'ATM':iS?'SUP':iR?'RES':iMP?'MP':'';
        const lblC=isA?'#00e5ff':iS?'#00ff88':iR?'#ff3355':'#ffe566';
        return`<div style="display:flex;align-items:center;gap:3px;margin-bottom:2px;height:13px">
          <div style="width:50px;text-align:right;font-family:monospace;font-size:7px;color:${isA?'#00e5ff':'#5a6f96'};flex-shrink:0">${r.strike}</div>
          <div style="width:24px;text-align:center;font-family:monospace;font-size:7px;color:${lblC};flex-shrink:0">${lbl}</div>
          <div style="flex:1;display:flex;height:9px;gap:1px">
            <div style="flex:1;display:flex;justify-content:flex-end"><div style="height:100%;width:${pw}%;background:rgba(0,255,136,${iS?.8:.3});border-radius:2px 0 0 2px;min-width:${r.pe.oi>0?1:0}px"></div></div>
            <div style="width:1px;background:#162030;flex-shrink:0"></div>
            <div style="flex:1"><div style="height:100%;width:${cw}%;background:rgba(255,51,85,${iR?.8:.3});border-radius:0 2px 2px 0;min-width:${r.ce.oi>0?1:0}px"></div></div>
          </div>
        </div>`;
      }).join('')}
      <div style="display:flex;justify-content:center;gap:16px;margin-top:5px"><span style="font-family:monospace;font-size:8px;color:#00ff88">█ PE OI (Support)</span><span style="font-family:monospace;font-size:8px;color:#ff3355">█ CE OI (Resistance)</span></div>
    </div>
  </div>`;

  // ── OPTION CHAIN TABLE WITH GAMMA ───────────────────────────────
  const tableRows=a.rows.map(r=>{
    const bg=r.isATM?'background:#0a1525;':'';
    const cCC=r.ce.oiChg>0?'#ff6b6b':r.ce.oiChg<0?'#51cf66':'#5a6f96';
    const pCC=r.pe.oiChg>0?'#51cf66':r.pe.oiChg<0?'#ff6b6b':'#5a6f96';
    const isS=r.strike===a.sup1, isR=r.strike===a.res1, isMP=r.strike===a.maxPain;
    const sK=r.isATM?'#00e5ff':isS?'#00ff88':isR?'#ff3355':isMP?'#ffe566':'#5a6f96';
    const sLabel=r.isATM?'★':isS?' S':isR?' R':isMP?' M':'';
    return`<tr style="${bg}">
      <td style="text-align:right;padding:3px 5px;font-family:monospace;font-size:8px;color:#ff8c00">${r.ce.iv}</td>
      <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:8px;color:#5a6f96">${r.ce.delta}</td>
      <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:8px;color:#bb66ff">${r.ce.gamma>0?r.ce.gamma.toFixed(5):'—'}</td>
      <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:8px;color:#253348">${r.ce.theta}</td>
      <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:8px;color:#00e5ff">${r.ce.vega}</td>
      <td style="text-align:right;padding:3px 5px;font-family:'Space Mono',monospace;font-size:8px;color:${cCC}">${N(r.ce.oi)}</td>
      <td style="text-align:right;padding:3px 4px;font-family:monospace;font-size:8px;color:${cCC}">${r.ce.oiChg!==0?(r.ce.oiChg>0?'+':'')+N(r.ce.oiChg):'—'}</td>
      <td style="text-align:right;padding:3px 5px;font-family:'Space Mono',monospace;font-size:9px;color:#dde8ff;font-weight:${r.isATM?700:400}">${r.ce.ltp}</td>
      <td style="text-align:center;padding:3px 6px;font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:${sK};background:rgba(255,255,255,.025)">${r.strike}${sLabel}</td>
      <td style="text-align:left;padding:3px 5px;font-family:'Space Mono',monospace;font-size:9px;color:#dde8ff;font-weight:${r.isATM?700:400}">${r.pe.ltp}</td>
      <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:8px;color:${pCC}">${r.pe.oiChg!==0?(r.pe.oiChg>0?'+':'')+N(r.pe.oiChg):'—'}</td>
      <td style="text-align:left;padding:3px 5px;font-family:'Space Mono',monospace;font-size:8px;color:${pCC}">${N(r.pe.oi)}</td>
      <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:8px;color:#00e5ff">${r.pe.vega}</td>
      <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:8px;color:#253348">${r.pe.theta}</td>
      <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:8px;color:#bb66ff">${r.pe.gamma>0?r.pe.gamma.toFixed(5):'—'}</td>
      <td style="text-align:left;padding:3px 4px;font-family:monospace;font-size:8px;color:#5a6f96">${r.pe.delta}</td>
      <td style="text-align:left;padding:3px 5px;font-family:monospace;font-size:8px;color:#ff8c00">${r.pe.iv}</td>
    </tr>`;
  }).join('');

  const symBtns=['NIFTY','BANKNIFTY','SENSEX'].map(s=>`<a href="/set?sym=${s}" style="padding:5px 12px;border-radius:7px;border:1px solid ${symbol===s?'rgba(0,229,255,.5)':'#253348'};background:${symbol===s?'rgba(0,229,255,.12)':'transparent'};color:${symbol===s?'#00e5ff':'#5a6f96'};font-family:monospace;font-size:9px;font-weight:700;text-decoration:none">${s}</a>`).join('');

  const mktStatus=a.isMarketOpen?`<span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:4px;border:1px solid rgba(0,255,136,.3);color:#00ff88;background:rgba(0,255,136,.08)">🟢 LIVE</span>`:`<span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:4px;border:1px solid #253348;color:#5a6f96">🔴 CLOSED</span>`;

  return`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${symbol} Option Chain v2</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}
table{width:100%;border-collapse:collapse}
tr:hover{background:rgba(255,255,255,.02)}
td{border-bottom:1px solid #080d18}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.ld{width:5px;height:5px;border-radius:50%;background:#00ff88;box-shadow:0 0 6px #00ff88;animation:bl 1.5s infinite;display:inline-block;vertical-align:middle}
@keyframes pu{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
</style>
</head><body>

<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:8px 12px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
      <span style="font-family:'Bebas Neue',cursive;font-size:15px;letter-spacing:3px;background:linear-gradient(90deg,#ffd700,#00ff88);-webkit-background-clip:text;-webkit-text-fill-color:transparent">OPTION CHAIN v2</span>
      <span style="font-family:monospace;font-size:9px;padding:3px 9px;border-radius:6px;border:1px solid ${a.confColor}55;background:${a.confColor}11;color:${a.confColor};font-weight:700;${a.masterSignal!=='WAIT'?'animation:pu 2s infinite':''}">${esc(a.masterSignal)}</span>
      ${mktStatus}
      ${a.isDemoData?'<span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:4px;border:1px solid rgba(244,196,48,.3);color:#f4c430">DEMO</span>':''}
    </div>
    <div style="display:flex;align-items:center;gap:5px">
      <span class="ld"></span>
      <span style="font-family:monospace;font-size:8px;color:#5a6f96">${esc(lastFetch)}</span>
      <a href="/refresh" style="background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.3);color:#00e5ff;font-family:monospace;font-size:8px;padding:4px 10px;border-radius:5px;text-decoration:none">↻</a>
    </div>
  </div>
  <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
    ${symBtns}
    <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:#dde8ff;margin-left:6px">${a.spot.toLocaleString('en-IN')}</div>
    <div style="font-family:monospace;font-size:9px;color:${a.spotTrend==='UP'?'#00ff88':a.spotTrend==='DOWN'?'#ff3355':'#5a6f96'}">${a.spotTrend==='UP'?'▲':a.spotTrend==='DOWN'?'▼':'—'} ${a.spotTrend}</div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96">DTE: ${a.dte}d · ${esc(a.expiry)}</div>
  </div>
</div>

${a.isDemoData?`<div style="background:rgba(244,196,48,.08);border-bottom:1px solid rgba(244,196,48,.3);padding:7px 12px;font-family:monospace;font-size:9px;color:#f4c430">⚠️ DEMO MODE — NSE API unavailable (market closed or blocked). Synthetic data with real Black-Scholes Greeks.</div>`:''}

<div style="padding:11px">
${sigBox}
${levelsBox}
${pcrBox}
${sentBox}
${sigList}
${oiChart}

<div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:10px;overflow-x:auto">
  <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">OPTION CHAIN TABLE — ★ATM S=Support R=Resistance M=MaxPain · Γ=Gamma NOW INCLUDED</div>
  <div style="min-width:800px">
  <table>
    <thead>
      <tr style="background:#0f1624">
        <th colspan="7" style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#ff3355;letter-spacing:2px">◄ CALLS</th>
        <th style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#5a6f96">STRIKE</th>
        <th colspan="7" style="text-align:center;padding:5px;font-family:monospace;font-size:8px;color:#00ff88;letter-spacing:2px">PUTS ►</th>
      </tr>
      <tr style="background:#06080e">
        <td style="text-align:right;padding:3px 5px;font-family:monospace;font-size:7px;color:#ff8c00">IV%</td>
        <td style="text-align:right;font-family:monospace;font-size:7px;color:#5a6f96">Δ</td>
        <td style="text-align:right;font-family:monospace;font-size:7px;color:#bb66ff">Γ</td>
        <td style="text-align:right;font-family:monospace;font-size:7px;color:#253348">Θ</td>
        <td style="text-align:right;font-family:monospace;font-size:7px;color:#00e5ff">V</td>
        <td style="text-align:right;padding:3px 5px;font-family:monospace;font-size:7px;color:#ff3355">OI</td>
        <td style="text-align:right;font-family:monospace;font-size:7px;color:#ff3355">ΔOI</td>
        <td style="text-align:right;padding:3px 5px;font-family:monospace;font-size:7px;color:#dde8ff">LTP</td>
        <td style="text-align:center;font-family:monospace;font-size:7px;color:#5a6f96;padding:3px 6px">STRIKE</td>
        <td style="text-align:left;padding:3px 5px;font-family:monospace;font-size:7px;color:#dde8ff">LTP</td>
        <td style="text-align:left;font-family:monospace;font-size:7px;color:#00ff88">ΔOI</td>
        <td style="text-align:left;padding:3px 5px;font-family:monospace;font-size:7px;color:#00ff88">OI</td>
        <td style="text-align:left;font-family:monospace;font-size:7px;color:#00e5ff">V</td>
        <td style="text-align:left;font-family:monospace;font-size:7px;color:#253348">Θ</td>
        <td style="text-align:left;font-family:monospace;font-size:7px;color:#bb66ff">Γ</td>
        <td style="text-align:left;font-family:monospace;font-size:7px;color:#5a6f96">Δ</td>
        <td style="text-align:left;padding:3px 5px;font-family:monospace;font-size:7px;color:#ff8c00">IV%</td>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</div>

<div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:10px;margin-bottom:10px">
  <div style="font-family:monospace;font-size:8px;color:#5a6f96;letter-spacing:2px;margin-bottom:8px">GREEKS LEGEND</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
    ${[['Δ Delta','₹ change per ₹1 index move. ATM≈0.5. CE positive, PE negative.','#5a6f96'],
       ['Γ Gamma','Rate of delta change. HIGHEST at ATM near expiry = dangerous. Use to gauge gamma risk.','#bb66ff'],
       ['Θ Theta','Daily decay in ₹. Always negative for buyers. Accelerates 0-7 DTE.','#ff8c00'],
       ['V Vega','Price change per 1% IV change. High when IV low = buy low-vega options.','#00e5ff'],
    ].map(([n,d,c])=>`<div style="padding:7px;background:#020409;border-radius:6px;border:1px solid #0f1624"><div style="font-family:monospace;font-size:9px;font-weight:700;color:${c};margin-bottom:2px">${n}</div><div style="font-family:monospace;font-size:8px;color:#5a6f96;line-height:1.5">${d}</div></div>`).join('')}
  </div>
</div>

<div style="text-align:center;font-family:monospace;font-size:8px;color:#253348;padding:8px">
  Data: NSE India (free) · Greeks: Black-Scholes · Fetches: ${fetchCount} · Refresh: ${a.isMarketOpen?'60s':'120s'}<br>
  ⚠️ Educational only. Not financial advice. Always paper trade first.
</div>
</div>

<script>
const ist=new Date(Date.now()+19800000);
const t=ist.getUTCHours()*60+ist.getUTCMinutes();
const open=ist.getUTCDay()>=1&&ist.getUTCDay()<=5&&t>=555&&t<=930;
setTimeout(()=>window.location.reload(),open?60000:120000);
</script>
</body></html>`;
}

// ── SERVER ───────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(`OK sym=${symbol} fetches=${fetchCount} err=${fetchError||'none'}`);return;}
  if(url.pathname==='/set'){const s=url.searchParams.get('sym');if(['NIFTY','BANKNIFTY','SENSEX'].includes(s)){symbol=s;analyzed=null;history=[];await refresh();}res.writeHead(302,{'Location':'/'});res.end();return;}
  if(url.pathname==='/refresh'){await refresh();res.writeHead(302,{'Location':'/'});res.end();return;}
  if(url.pathname==='/reset'){analyzed=null;history=[];fetchCount=0;fetchError=null;await refresh();res.writeHead(302,{'Location':'/'});res.end();return;}
  if(!analyzed)await refresh();
  try{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(buildHTML());}
  catch(e){console.error(e.message);res.writeHead(200,{'Content-Type':'text/plain'});res.end('Option Chain v2 starting... '+e.message);}
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('═══════════════════════════════════════════════');
  console.log(' OPTION CHAIN ANALYZER v2 — GOD LEVEL PRO');
  console.log('═══════════════════════════════════════════════');
  console.log(' Instruments: Nifty · BankNifty · Sensex');
  console.log(' Signal: 12-factor engine with confidence tier');
  console.log(' Strike: Exact ATM/OTM recommendation');
  console.log(' Overnight: Carry or square off decision');
  console.log(' Gamma column: Added to chain table');
  console.log(' BUILD: npm install  |  START: node server.js');
  console.log('═══════════════════════════════════════════════');
  refresh();
  setInterval(refresh,60000);
});
server.on('error',e=>{console.error('FATAL:',e.message);process.exit(1);});
