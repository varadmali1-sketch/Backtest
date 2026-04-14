// ══════════════════════════════════════════════════════════════════
//  INDIA PAPER TRADER v2 — Forward Test Bot
//  Yahoo Finance live prices — NO API KEY NEEDED
//  12 strategies — 5-phase ATR trail — AUTO/MANUAL/OFF
//  Market hours: Mon-Fri 9:15 AM - 3:30 PM IST
//  Runs 24x7 on Render — phone can be off
// ══════════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 10000;
const CAPITAL = parseFloat(process.env.CAPITAL || '100000');

// ── STATE ─────────────────────────────────────────────────────────
let capital = CAPITAL, startCap = CAPITAL;
let positions = [], closed = [], feed = [], logs = [];
let cycleCount = 0, botMode = 'AUTO';
let marketOpen = false, isExpiry = false;
let dailyPnL = 0, weeklyPnL = 0, dailyStop = false;
let startTime = Date.now(), lastFetch = '—', lastCycle = '—';
let partialExits = 0;

// Market data
let MD = {
  nLTP: 22500, nPrev: 22500, nOpen: 22500,
  nHigh: 0, nLow: 0, nVWAP: 22500,
  ema9: 22500, ema21: 22500,
  rsi: 50, rsiPrev: 50,
  macdH: 0, prevMacdH: 0,
  vix: 15, atr: 80,
  change: 0, changePct: 0,
  prevDayH: 22600, prevDayL: 22300, prevDayC: 22450,
  supertrend: 'UP', prevSupertrend: 'UP',
  dataSource: 'waiting...'
};

// Strategy win tracking
let sS={}, sW={};
['TrendMom','EMACross','GapPlay','RSIRev','VWAPBounce',
 'PivotReact','MACDCross','StrongClose','InsideBar',
 'ExpiryPlay','HighVIX','WeekBreak'].forEach(s=>{sS[s]=0;sW[s]=0;});

function tlog(t,m){
  const l='['+new Date().toISOString().slice(11,19)+']['+t+'] '+m;
  console.log(l);logs.push(l);if(logs.length>200)logs.shift();
}
function addFeed(ic,lb,msg,amt,side){
  feed.push({t:new Date().toISOString().slice(11,19),ic,lb,msg,amt:amt||'',side});
  if(feed.length>80)feed.shift();
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── FETCH NIFTY FROM YAHOO FINANCE ───────────────────────────────
async function fetchNifty() {
  return new Promise(resolve => {
    const now = Math.floor(Date.now()/1000);
    const from = now - 7200; // last 2 hours
    const req = https.request({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/%5ENSEI?period1=${from}&period2=${now}&interval=1m`,
      method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'application/json'},
      timeout: 8000
    }, r => {
      let d = '';
      r.on('data', x => d += x);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const res = j?.chart?.result?.[0];
          if(!res) { resolve(false); return; }
          const closes = res.indicators?.quote?.[0]?.close || [];
          const highs  = res.indicators?.quote?.[0]?.high  || [];
          const lows   = res.indicators?.quote?.[0]?.low   || [];
          const opens  = res.indicators?.quote?.[0]?.open  || [];
          const validCloses = closes.filter(Boolean);
          if(!validCloses.length) { resolve(false); return; }
          MD.nPrev = MD.nLTP;
          MD.nLTP  = Math.round(validCloses[validCloses.length-1]);
          // Day high/low
          const todayHighs = highs.filter(Boolean);
          const todayLows  = lows.filter(Boolean);
          if(todayHighs.length) MD.nHigh = Math.round(Math.max(...todayHighs));
          if(todayLows.length)  MD.nLow  = Math.round(Math.min(...todayLows));
          if(opens.filter(Boolean).length) MD.nOpen = Math.round(opens.filter(Boolean)[0]);
          MD.nVWAP = Math.round((MD.nHigh + MD.nLow + MD.nLTP) / 3);
          MD.change = MD.nLTP - MD.nPrev;
          MD.changePct = MD.nPrev > 0 ? +((MD.nLTP-MD.nPrev)/MD.nPrev*100).toFixed(2) : 0;
          MD.dataSource = 'Yahoo Finance (live)';
          lastFetch = new Date(Date.now()+19800000).toISOString().slice(11,16)+' IST';
          resolve(true);
        } catch(e) {
          tlog('WARN','Yahoo parse: '+e.message);
          resolve(false);
        }
      });
    });
    req.on('error', ()=>resolve(false));
    req.on('timeout', ()=>{ req.destroy(); resolve(false); });
    req.end();
  });
}

// Fallback: simulate price movement
function simNifty() {
  MD.nPrev = MD.nLTP;
  const noise = (Math.random()-0.49)*0.004;
  MD.nLTP = Math.round(Math.max(15000, MD.nLTP*(1+noise)));
  if(!MD.nHigh || MD.nLTP > MD.nHigh) MD.nHigh = MD.nLTP;
  if(!MD.nLow  || MD.nLTP < MD.nLow)  MD.nLow  = MD.nLTP;
  MD.nVWAP = Math.round((MD.nHigh+MD.nLow+MD.nLTP)/3);
  MD.change = MD.nLTP - MD.nPrev;
  MD.changePct = MD.nPrev > 0 ? +((MD.nLTP-MD.nPrev)/MD.nPrev*100).toFixed(2) : 0;
  MD.dataSource = 'Simulated (Yahoo unavailable)';
  lastFetch = 'SIM '+new Date().toISOString().slice(11,16);
}

// Update indicators after price fetch
function updateIndicators() {
  MD.ema9  = MD.ema9 *(1-2/10)+MD.nLTP*(2/10);
  MD.ema21 = MD.ema21*(1-2/22)+MD.nLTP*(2/22);
  MD.rsiPrev = MD.rsi;
  // Simple RSI approx from price change
  const chg = MD.nLTP - MD.nPrev;
  if(chg > 0) MD.rsi = Math.min(80, MD.rsi + Math.abs(chg)/MD.nLTP*400);
  else         MD.rsi = Math.max(20, MD.rsi - Math.abs(chg)/MD.nLTP*400);
  MD.prevSupertrend = MD.supertrend;
  MD.supertrend = MD.nLTP > MD.ema21 ? 'UP' : 'DOWN';
  MD.prevMacdH = MD.macdH;
  const macd = MD.ema9 - MD.ema21;
  MD.macdH = macd - (MD.macdH*0.85 + macd*0.15);
  MD.atr = Math.max(40, Math.abs(MD.nHigh - MD.nLow)*0.6 || 80);
  MD.vix = Math.max(10, Math.min(45, MD.vix+(Math.random()-0.5)*0.2));
}

// ── MARKET SESSION (IST) ─────────────────────────────────────────
function checkSession() {
  const ist = new Date(Date.now()+19800000);
  const day = ist.getUTCDay();
  const t   = ist.getUTCHours()*60 + ist.getUTCMinutes();
  const was = marketOpen;
  marketOpen = day>=1 && day<=5 && t>=555 && t<=930;
  isExpiry   = day===4; // Thursday
  if(!was && marketOpen) {
    dailyPnL=0; dailyStop=false;
    MD.nHigh=0; MD.nLow=0; MD.nOpen=MD.nLTP;
    tlog('INFO','🔔 Market OPEN 9:15 AM IST'+(isExpiry?' [EXPIRY DAY]':''));
    addFeed('🔔','MARKET OPEN','NSE/BSE 9:15 AM IST. 12 strategies active.'+(isExpiry?' ⚡ Expiry day — Gamma play active.':''),null,'info');
  }
  if(was && !marketOpen) {
    tlog('INFO','🔕 Market CLOSED 3:30 PM IST. Squaring off all positions.');
    squareAll('Market closed 3:30 PM IST');
    addFeed('🔕','MARKET CLOSED','All paper positions squared off at 3:30 PM.',null,'info');
  }
}
function tIST(){ const ist=new Date(Date.now()+19800000); return ist.getUTCHours()*60+ist.getUTCMinutes(); }
function noLate(){ return tIST()<=870; } // No new entries after 2:30 PM
function inWindow(){ const t=tIST(); return (t>=570&&t<=690)||(t>=750&&t<=870); }

// ── 12 STRATEGIES ────────────────────────────────────────────────

function signals() {
  const sigs = [];
  const t = tIST();
  if(!noLate()) return sigs;

  // 1. Trend Momentum — price moving strongly with EMA support
  if(inWindow()) {
    if(MD.changePct>0.4 && MD.ema9>MD.ema21 && MD.rsi>52 && MD.rsi<72 && MD.nLTP>MD.nVWAP)
      sigs.push({opt:'CE',strat:'TrendMom',conf:74,reason:'Nifty +'+MD.changePct+'% + EMA bull + above VWAP. RSI:'+MD.rsi.toFixed(0)+'.'});
    if(MD.changePct<-0.4 && MD.ema9<MD.ema21 && MD.rsi<48 && MD.rsi>28 && MD.nLTP<MD.nVWAP)
      sigs.push({opt:'PE',strat:'TrendMom',conf:72,reason:'Nifty '+MD.changePct+'% + EMA bear + below VWAP. RSI:'+MD.rsi.toFixed(0)+'.'});
  }

  // 2. EMA Cross — fresh crossover signal
  if(inWindow()) {
    if(MD.supertrend==='UP' && MD.prevSupertrend==='DOWN' && MD.rsi>46 && MD.rsi<68)
      sigs.push({opt:'CE',strat:'EMACross',conf:76,reason:'EMA(9) just crossed above EMA(21). Fresh bullish cross. RSI:'+MD.rsi.toFixed(0)+'.'});
    if(MD.supertrend==='DOWN' && MD.prevSupertrend==='UP' && MD.rsi<54 && MD.rsi>32)
      sigs.push({opt:'PE',strat:'EMACross',conf:74,reason:'EMA(9) just crossed below EMA(21). Fresh bearish cross. RSI:'+MD.rsi.toFixed(0)+'.'});
  }

  // 3. Gap Play — gap open with follow-through (only first 25 min)
  if(t>=555 && t<=580) {
    const gapPct = MD.nOpen>0 ? (MD.nLTP-MD.nOpen)/MD.nOpen*100 : 0;
    if(gapPct>0.4 && MD.nLTP>MD.nOpen && MD.ema9>MD.ema21)
      sigs.push({opt:'CE',strat:'GapPlay',conf:73,reason:'Gap-up '+gapPct.toFixed(2)+'% with follow-through. EMA bullish.'});
    if(gapPct<-0.4 && MD.nLTP<MD.nOpen && MD.ema9<MD.ema21)
      sigs.push({opt:'PE',strat:'GapPlay',conf:71,reason:'Gap-down '+Math.abs(gapPct).toFixed(2)+'% with follow-through. EMA bearish.'});
  }

  // 4. RSI Reversal — RSI extremes reversing
  if(inWindow()) {
    if(MD.rsiPrev<32 && MD.rsi>34 && MD.nLTP>MD.nPrev)
      sigs.push({opt:'CE',strat:'RSIRev',conf:75,reason:'RSI was oversold ('+MD.rsiPrev.toFixed(0)+') now recovering to '+MD.rsi.toFixed(0)+'. Buy dip.'});
    if(MD.rsiPrev>68 && MD.rsi<66 && MD.nLTP<MD.nPrev)
      sigs.push({opt:'PE',strat:'RSIRev',conf:73,reason:'RSI was overbought ('+MD.rsiPrev.toFixed(0)+') now falling to '+MD.rsi.toFixed(0)+'. Sell top.'});
  }

  // 5. VWAP Bounce — price bounces off VWAP
  if(inWindow()) {
    const vwapDev = (MD.nLTP-MD.nVWAP)/MD.nVWAP*100;
    if(vwapDev>0.2 && MD.nPrev<MD.nVWAP && MD.nLTP>MD.nVWAP && MD.rsi>50)
      sigs.push({opt:'CE',strat:'VWAPBounce',conf:75,reason:'Price reclaimed VWAP ('+MD.nVWAP+'). Institutional support. RSI:'+MD.rsi.toFixed(0)+'.'});
    if(vwapDev<-0.2 && MD.nPrev>MD.nVWAP && MD.nLTP<MD.nVWAP && MD.rsi<50)
      sigs.push({opt:'PE',strat:'VWAPBounce',conf:73,reason:'Price broke below VWAP ('+MD.nVWAP+'). Selling pressure. RSI:'+MD.rsi.toFixed(0)+'.'});
  }

  // 6. Pivot Reaction — S1/R1 bounce
  if(inWindow()) {
    const pp=(MD.prevDayH+MD.prevDayL+MD.prevDayC)/3;
    const s1=Math.round(2*pp-MD.prevDayH), r1=Math.round(2*pp-MD.prevDayL);
    if(Math.abs(MD.nLTP-s1)<MD.atr*0.4 && MD.rsi<45 && MD.nLTP>MD.nPrev)
      sigs.push({opt:'CE',strat:'PivotReact',conf:74,reason:'Price bouncing from S1 pivot ('+s1+'). RSI '+MD.rsi.toFixed(0)+' turning up.'});
    if(Math.abs(MD.nLTP-r1)<MD.atr*0.4 && MD.rsi>55 && MD.nLTP<MD.nPrev)
      sigs.push({opt:'PE',strat:'PivotReact',conf:72,reason:'Price rejected at R1 pivot ('+r1+'). RSI '+MD.rsi.toFixed(0)+' turning down.'});
  }

  // 7. MACD Cross — histogram flips
  if(inWindow()) {
    if(MD.macdH>0 && MD.prevMacdH<=0 && MD.nLTP>MD.nPrev && MD.rsi>46 && MD.rsi<68)
      sigs.push({opt:'CE',strat:'MACDCross',conf:74,reason:'MACD histogram turned positive. Bullish momentum building. RSI:'+MD.rsi.toFixed(0)+'.'});
    if(MD.macdH<0 && MD.prevMacdH>=0 && MD.nLTP<MD.nPrev && MD.rsi<54 && MD.rsi>32)
      sigs.push({opt:'PE',strat:'MACDCross',conf:72,reason:'MACD histogram turned negative. Bearish momentum building. RSI:'+MD.rsi.toFixed(0)+'.'});
  }

  // 8. Strong Close follow-through (morning only)
  if(t>=555 && t<=600) {
    const prevRange=MD.prevDayH-MD.prevDayL;
    if(prevRange>80) {
      const closePct=(MD.prevDayC-MD.prevDayL)/prevRange;
      if(closePct>0.78 && MD.nLTP>MD.prevDayC && MD.ema9>MD.ema21)
        sigs.push({opt:'CE',strat:'StrongClose',conf:73,reason:'Yesterday strong bull close ('+Math.round(closePct*100)+'% range). Follow-through buying.'});
      if(closePct<0.22 && MD.nLTP<MD.prevDayC && MD.ema9<MD.ema21)
        sigs.push({opt:'PE',strat:'StrongClose',conf:71,reason:'Yesterday strong bear close ('+Math.round(closePct*100)+'% range). Follow-through selling.'});
    }
  }

  // 9. Inside Bar Breakout
  if(inWindow() && MD.nHigh>0 && MD.nLow>0) {
    const prevRange=MD.prevDayH-MD.prevDayL;
    const todayRange=MD.nHigh-MD.nLow;
    if(todayRange<prevRange*0.5) { // Inside day so far
      if(MD.nLTP>MD.prevDayH*1.001 && MD.rsi>52)
        sigs.push({opt:'CE',strat:'InsideBar',conf:76,reason:'Inside bar breakout above prev high ('+MD.prevDayH+'). Volatility expansion. RSI:'+MD.rsi.toFixed(0)+'.'});
      if(MD.nLTP<MD.prevDayL*0.999 && MD.rsi<48)
        sigs.push({opt:'PE',strat:'InsideBar',conf:74,reason:'Inside bar breakdown below prev low ('+MD.prevDayL+'). Volatility expansion. RSI:'+MD.rsi.toFixed(0)+'.'});
    }
  }

  // 10. Expiry Play (Thursday only — 9:30-11 AM and 2-3:15 PM)
  if(isExpiry && ((t>=570&&t<=660)||(t>=840&&t<=915)) && MD.vix<28) {
    if(MD.nLTP>MD.nVWAP && MD.rsi>58 && MD.ema9>MD.ema21)
      sigs.push({opt:'CE',strat:'ExpiryPlay',conf:75,reason:'EXPIRY: Price above VWAP + EMA bull + RSI:'+MD.rsi.toFixed(0)+'. Gamma scalp CE.'});
    if(MD.nLTP<MD.nVWAP && MD.rsi<42 && MD.ema9<MD.ema21)
      sigs.push({opt:'PE',strat:'ExpiryPlay',conf:73,reason:'EXPIRY: Price below VWAP + EMA bear + RSI:'+MD.rsi.toFixed(0)+'. Gamma scalp PE.'});
  }

  // 11. High VIX Fear Buy — when VIX spikes, buy CE (fear = bottom)
  if(inWindow() && MD.vix>22 && MD.vix<38) {
    if(MD.rsi>38 && MD.rsi<55 && MD.nLTP>MD.nPrev && MD.ema9>MD.ema50-50)
      sigs.push({opt:'CE',strat:'HighVIX',conf:72,reason:'VIX elevated '+MD.vix.toFixed(1)+'% = fear peak. Price recovering. Buying dip CE.'});
  }

  // 12. Weekly Breakout — price breaks prev day high/low with momentum
  if(inWindow()) {
    if(MD.nLTP>MD.prevDayH*1.002 && MD.nLTP>MD.nOpen && MD.rsi>55 && MD.ema9>MD.ema21)
      sigs.push({opt:'CE',strat:'WeekBreak',conf:74,reason:'Breakout above prev day high ('+MD.prevDayH+'). RSI:'+MD.rsi.toFixed(0)+'. Momentum CE.'});
    if(MD.nLTP<MD.prevDayL*0.998 && MD.nLTP<MD.nOpen && MD.rsi<45 && MD.ema9<MD.ema21)
      sigs.push({opt:'PE',strat:'WeekBreak',conf:72,reason:'Breakdown below prev day low ('+MD.prevDayL+'). RSI:'+MD.rsi.toFixed(0)+'. Momentum PE.'});
  }

  // Remove duplicates (same strat already in positions)
  return sigs.filter(s => !positions.find(p=>p.strat===s.strat))
             .filter(s => s.conf >= 72)
             .sort((a,b)=>b.conf-a.conf);
}

// ── POSITION SIZING ───────────────────────────────────────────────
function getLots(conf) {
  if(MD.vix>30) return 1;
  return Math.min(2, Math.max(1, Math.floor(conf/60)));
}

function getPremium() {
  // ATM premium estimate: Spot × IV × sqrt(DTE/365) × 0.4
  const iv = Math.max(12, MD.vix * 1.05) / 100;
  const ist = new Date(Date.now()+19800000);
  const day = ist.getUTCDay();
  const dte = Math.max(1, day<=4 ? 4-day : 4+(7-day));
  const prem = Math.round(MD.nLTP * iv * Math.sqrt(dte/365) * 0.42);
  return Math.max(30, Math.min(300, prem));
}

// ── ENTER POSITION ────────────────────────────────────────────────
function enter(sig) {
  const lots = getLots(sig.conf);
  const lotSize = 25;
  const qty = lots * lotSize;
  const prem = getPremium();
  const entry = Math.round(prem * 1.015); // 1.5% slippage
  const sl   = Math.round(entry * 0.60);  // 40% SL
  const tp   = Math.round(entry * 1.65);  // 65% TP
  const spent = entry * qty;

  if(spent > capital * 0.06) return; // Max 6% per trade
  if(capital < spent * 1.1)  return;

  const atm = Math.round(MD.nLTP/50)*50;
  const strike = sig.opt==='CE' ? atm+50 : atm-50;

  capital -= spent;
  const id = Date.now();
  positions.push({
    id, sym:'NIFTY_'+strike+'_'+sig.opt,
    opt:sig.opt, strike, strat:sig.strat, conf:sig.conf,
    entry, cur:entry, peak:entry, sl, tp,
    trailFloor:sl, trailPhase:0,
    qty, spent, reason:sig.reason,
    openTime:id, partialDone:false,
    _niftyAtEntry: MD.nLTP
  });
  if(sS[sig.strat]!==undefined) sS[sig.strat]++;

  tlog('TRADE','PAPER BUY NIFTY '+strike+sig.opt+' ₹'+entry+' qty:'+qty+' ['+sig.strat+'] conf:'+sig.conf+'%');
  addFeed(sig.opt==='CE'?'📈':'📉','📋 PAPER '+sig.strat+' BUY '+sig.opt,
    'NIFTY '+strike+' '+sig.opt+' | '+sig.reason.slice(0,80),
    '₹'+spent.toFixed(0),'entry');
}

// ── 5-PHASE ATR TRAIL ─────────────────────────────────────────────
function updateTrail(pos) {
  const pp = (pos.cur-pos.entry)/pos.entry*100;
  const atrP = MD.atr * 0.5; // ATR in premium terms
  let fl = null;
  if(pp>=80){       fl=pos.peak*0.88;  pos.trailPhase=4; }
  else if(pp>=50) { fl=pos.peak-atrP*0.7; pos.trailPhase=3; }
  else if(pp>=30) { fl=pos.peak-atrP*1.0; pos.trailPhase=2; }
  else if(pp>=15) { fl=pos.peak-atrP*1.5; pos.trailPhase=1; }
  else {            fl=pos.sl;              pos.trailPhase=0; }
  // Time floor: after 30 min in profit, never lose
  const hm=(Date.now()-pos.openTime)/60000;
  if(hm>=30&&pp>0) fl=Math.max(fl, pos.entry*1.01);
  if(fl!==null&&fl>(pos.trailFloor||0)) pos.trailFloor=fl;
}

// ── PARTIAL EXIT at +40% ──────────────────────────────────────────
function checkPartial(pos) {
  if(pos.partialDone) return;
  const pp=(pos.cur-pos.entry)/pos.entry*100;
  if(pp>=40) {
    const hq=Math.floor(pos.qty/2);
    const hpnl=(pos.cur-pos.entry)*hq;
    capital+=pos.entry*hq+hpnl; dailyPnL+=hpnl;
    pos.qty-=hq; pos.spent=pos.entry*pos.qty;
    pos.partialDone=true; partialExits++;
    tlog('TRADE','PARTIAL '+pos.sym+' 50% at +'+pp.toFixed(0)+'% ₹'+hpnl.toFixed(0));
    addFeed('📤','PARTIAL EXIT '+pos.strat,pos.sym+' 50% off at +'+pp.toFixed(0)+'%. Half remains.','+₹'+hpnl.toFixed(0),'win');
  }
}

// ── SIMULATE POSITION PRICE UPDATE ───────────────────────────────
function updatePositionPrice(pos) {
  // Delta-based: option moves with index
  const indexMovePct = MD.nLTP > 0 && pos._niftyAtEntry > 0
    ? (MD.nLTP - pos._niftyAtEntry) / pos._niftyAtEntry * 100
    : 0;
  const delta = pos.opt==='CE' ? 0.45 : -0.45;
  const premMovePct = indexMovePct * delta * 2.2; // ATM option leverage ~2.2x
  const noise = (Math.random()-0.50)*0.02;
  pos.cur = Math.max(1, Math.round(pos.entry * (1 + premMovePct/100 + noise)));
  if(pos.cur > pos.peak) pos.peak = pos.cur;
}

// ── CHECK EXITS ───────────────────────────────────────────────────
function checkExits() {
  for(let i=positions.length-1; i>=0; i--) {
    const pos = positions[i];
    updatePositionPrice(pos);
    updateTrail(pos);
    checkPartial(pos);
    const pnl = (pos.cur-pos.entry)*pos.qty;
    const hm  = (Date.now()-pos.openTime)/60000;
    let reason=null, type=null;

    if(pos.cur <= pos.sl)
      { reason='SL hit ₹'+pos.cur+'. Max loss ₹'+Math.abs(pnl).toFixed(0); type='SL'; }
    else if(pos.trailFloor>pos.sl && pos.cur<pos.trailFloor && pos.trailPhase>0)
      { reason='Trail Ph'+pos.trailPhase+' ₹'+pos.cur+'. Gain ₹'+pnl.toFixed(0); type='TRAIL'; }
    else if(pos.cur >= pos.tp)
      { reason='Target +65% hit ₹'+pos.cur; type='TP'; }
    else if(!marketOpen)
      { reason='Market closed EOD'; type='EOD'; }
    else if(hm>90)
      { reason='Time stop 90min ₹'+pnl.toFixed(0); type='TIME'; }
    else if(MD.vix>38)
      { reason='VIX>38 black swan exit'; type='VIX'; }

    if(reason) doExit(pos, i, reason, pnl, type);
  }
}

function doExit(pos, idx, reason, pnl, type) {
  capital += pos.spent + pnl;
  dailyPnL += pnl;
  closed.push({...pos, win:pnl>0, pnl, reason, type, exit:pos.cur,
    held:Math.round((Date.now()-pos.openTime)/60000),
    time:new Date().toISOString().slice(11,19)});
  if(sS[pos.strat]!==undefined){sS[pos.strat]++;if(pnl>0)sW[pos.strat]++;}
  positions.splice(idx,1);
  const ic={SL:'🛑',TP:'💰',TRAIL:'📈',EOD:'🔕',TIME:'⏱',VIX:'⚡'};
  tlog('TRADE',type+' '+pos.sym+' ₹'+pnl.toFixed(0)+' ['+pos.strat+']');
  addFeed(ic[type]||'🔴','📋 PAPER '+type+' '+pos.strat,
    pos.sym+' — '+reason,
    (pnl>=0?'+':'')+'₹'+Math.abs(pnl).toFixed(0), pnl>0?'win':'loss');
}

function squareAll(reason) {
  for(let i=positions.length-1;i>=0;i--) {
    const p=positions[i];
    const pnl=(p.cur-p.entry)*p.qty;
    doExit(p,i,reason||'Square off',pnl,'EOD');
  }
}

// ── DAILY/WEEKLY STOP CHECK ───────────────────────────────────────
function stopCheck() {
  const dailyLimit = CAPITAL * 0.03;
  if(dailyPnL < -dailyLimit && !dailyStop) {
    dailyStop=true;
    addFeed('🛡','DAILY STOP','3% daily loss limit hit. No new trades today.',null,'guard');
    tlog('WARN','DAILY STOP: ₹'+dailyPnL.toFixed(0));
  }
  return !dailyStop;
}

// ── MAIN CYCLE ────────────────────────────────────────────────────
async function runCycle() {
  cycleCount++;
  lastCycle = new Date(Date.now()+19800000).toISOString().slice(11,16)+' IST';
  checkSession();

  // Fetch live prices
  const gotLive = await fetchNifty();
  if(!gotLive) simNifty();
  updateIndicators();

  // Update prev day data at market open
  if(marketOpen && MD.nOpen>0 && MD.nHigh===0) {
    MD.prevDayH = MD.nHigh || MD.nLTP+80;
    MD.prevDayL = MD.nLow  || MD.nLTP-80;
    MD.prevDayC = MD.nPrev || MD.nLTP;
  }

  checkExits();

  if(marketOpen && botMode==='AUTO' && stopCheck() && positions.length<4 && MD.vix<36 && noLateEntry()) {
    const sigs = signals();
    for(const sig of sigs.slice(0,2)) {
      if(positions.length<4) enter(sig);
    }
  }

  const pnl = positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  const tot=closed.length, wins=closed.filter(t=>t.win).length;
  tlog('INFO','#'+cycleCount+' ['+botMode+'] N:'+MD.nLTP+' VIX:'+MD.vix.toFixed(1)+
       ' Open:'+positions.length+' Closed:'+tot+
       ' Win:'+(tot?Math.round(wins/tot*100):0)+'% PnL:₹'+pnl.toFixed(0));
}

function noLateEntry(){ return tIST()<=870; }

// ── DASHBOARD ─────────────────────────────────────────────────────
function buildPage(tab) {
  const totalPnL=positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  const wins=closed.filter(t=>t.win).length, tot=closed.length, losses=tot-wins;
  const wr=tot?Math.round(wins/tot*100):0;
  const up=Math.round((Date.now()-startTime)/60000);
  const mc=botMode==='AUTO'?'#00ff88':botMode==='MANUAL'?'#f4c430':'#ff3355';
  const pnlCol=totalPnL>=0?'#00ff88':'#ff3355';
  const ist=new Date(Date.now()+19800000).toISOString().slice(11,16)+' IST';

  // Feed
  const feedHtml = !feed.length
    ? `<div style="font-family:monospace;font-size:11px;color:#253348;padding:18px;text-align:center">
        ${marketOpen?'Scanning 12 strategies every 30 seconds...':'Market closed. Opens Mon-Fri 9:15 AM IST.'}
       </div>`
    : [...feed].reverse().slice(0,25).map(f=>{
        const col=f.side==='entry'?'#00ff88':f.side==='win'?'#00ff88':f.side==='loss'?'#ff3355':f.side==='guard'?'#ff8c00':'#5a6f96';
        return `<div style="display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #0f1624;border-left:3px solid ${col}">
          <div style="font-size:16px;width:20px;flex-shrink:0">${esc(f.ic)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-family:monospace;font-size:8px;color:#bb66ff;margin-bottom:2px;font-weight:700">${esc(f.lb)}</div>
            <div style="font-family:monospace;font-size:10px;color:#5a6f96;line-height:1.5">${esc(f.msg)}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${f.amt?`<div style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${esc(f.amt)}</div>`:''}
            <div style="font-family:monospace;font-size:7px;color:#253348;margin-top:2px">${esc(f.t)}</div>
          </div>
        </div>`;
      }).join('');

  // Positions
  const posHtml = !positions.length
    ? `<div style="font-family:monospace;font-size:11px;color:#253348;padding:14px;text-align:center">
        No positions. ${marketOpen?'Bot scanning...':'Market closed.'}
       </div>`
    : positions.map(pos=>{
        const pnl=(pos.cur-pos.entry)*pos.qty, pp=(pos.cur/pos.entry-1)*100;
        const col=pnl>=0?'#00ff88':'#ff3355';
        const hm=Math.round((Date.now()-pos.openTime)/60000);
        const phl=['Fixed SL','Trail 1.5×ATR','Trail 1×ATR','Trail 0.7×ATR','Trail 0.4×ATR'];
        return `<div style="padding:11px;border:1px solid #0f1624;border-radius:10px;background:#06080e;margin-bottom:8px;border-left:3px solid ${col}">
          <div style="display:flex;justify-content:space-between;margin-bottom:7px">
            <div>
              <div style="font-weight:700;font-size:12px">NIFTY ${esc(pos.strike)} ${esc(pos.opt)}
                <span style="font-family:monospace;font-size:8px;padding:2px 5px;border-radius:3px;border:1px solid rgba(187,102,255,.3);background:rgba(187,102,255,.1);color:#bb66ff">${esc(pos.strat)}</span>
                ${pos.partialDone?'<span style="font-family:monospace;font-size:7px;color:#f4c430;margin-left:4px">½ SOLD</span>':''}
              </div>
              <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:2px">📋 PAPER · ${hm}m · conf:${pos.conf}%</div>
            </div>
            <div style="text-align:right">
              <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:${col}">${(pnl>=0?'+':'')+'₹'+Math.abs(pnl).toFixed(0)}</div>
              <div style="font-family:monospace;font-size:8px;color:#5a6f96">${pp.toFixed(1)}%</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-bottom:7px">
            ${[['Entry','₹'+pos.entry,'#dde8ff'],['LTP','₹'+pos.cur,'#00e5ff'],['Peak','₹'+pos.peak,'#f4c430'],['Target','₹'+pos.tp,'#00ff88']]
              .map(([l,v,c])=>`<div style="font-family:monospace;font-size:9px;padding:4px;background:#090b15;border-radius:5px;border:1px solid #0f1624"><span style="color:#253348;display:block">${l}</span><span style="color:${c};font-weight:600">${v}</span></div>`).join('')}
          </div>
          <div style="background:rgba(255,229,102,.04);border:1px solid rgba(255,229,102,.12);border-radius:6px;padding:6px 9px">
            <div style="font-family:monospace;font-size:7px;color:#ffe566;margin-bottom:4px">5-PHASE ATR TRAIL</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
              ${[['Phase',pos.trailPhase,'#ffe566'],['Floor','₹'+(pos.trailFloor||pos.sl),'#00ff88'],['Mode',phl[pos.trailPhase]||'—','#ffe566']]
                .map(([l,v,c])=>`<div style="text-align:center"><div style="font-family:monospace;font-size:7px;color:#253348">${l}</div><div style="font-family:monospace;font-size:10px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
            </div>
          </div>
          <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:6px">${esc(pos.reason.slice(0,90))}</div>
        </div>`;
      }).join('');

  // Strategy bars
  const scls={TrendMom:'#ff8c00',EMACross:'#00e5ff',GapPlay:'#f4c430',RSIRev:'#bb66ff',
    VWAPBounce:'#4499ff',PivotReact:'#ff8c00',MACDCross:'#00ff88',StrongClose:'#ffe566',
    InsideBar:'#00e5ff',ExpiryPlay:'#ff3355',HighVIX:'#f4c430',WeekBreak:'#00ff88'};
  const stratBars=Object.keys(sS).map(s=>{
    const t=sS[s]||0,w=sW[s]||0;if(!t)return'';
    const r=Math.round(w/t*100);
    return `<div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">
      <span style="font-family:monospace;font-size:8px;color:#5a6f96;width:90px;flex-shrink:0">${s}</span>
      <div style="flex:1;height:4px;background:#0f1624;border-radius:2px;overflow:hidden"><div style="height:100%;width:${r}%;background:${scls[s]||'#5a6f96'};border-radius:2px"></div></div>
      <span style="font-family:monospace;font-size:8px;color:${scls[s]||'#5a6f96'};min-width:52px;text-align:right">${r}% (${t})</span>
    </div>`;
  }).join('');

  // History
  const histHtml = !closed.length
    ? '<div style="font-family:monospace;font-size:11px;color:#253348;padding:10px;text-align:center">No closed trades yet.</div>'
    : [...closed].reverse().slice(0,30).map(t=>{
        const col=t.win?'#00ff88':'#ff3355';
        return `<div style="display:flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid #0f1624;border-radius:8px;background:#06080e;margin-bottom:5px;border-left:3px solid ${col}">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;flex-wrap:wrap">
              <span style="font-weight:700;font-size:12px;color:#dde8ff">NIFTY ${esc(t.strike)} ${esc(t.opt)}</span>
              <span style="font-family:monospace;font-size:8px;padding:1px 5px;border-radius:3px;font-weight:700;background:${t.win?'rgba(0,255,136,.12)':'rgba(255,51,85,.1)'};color:${col};border:1px solid ${col}">${t.win?'WIN':'LOSS'}</span>
              <span style="font-family:monospace;font-size:8px;color:#bb66ff;border:1px solid rgba(187,102,255,.2);padding:1px 5px;border-radius:3px">${esc(t.strat)}</span>
              <span style="font-family:monospace;font-size:7px;color:#253348">${esc(t.type)}</span>
            </div>
            <div style="font-family:monospace;font-size:8px;color:#253348">${esc(t.reason.slice(0,70))} · ${t.held}m · ${esc(t.time)}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${(t.pnl>=0?'+':'')+'₹'+Math.abs(t.pnl).toFixed(0)}</div>
          </div>
        </div>`;
      }).join('');

  // Log
  const logHtml=logs.slice(-60).reverse().map(l=>{
    const col=l.includes('[TRADE]')?'#00ff88':l.includes('[WARN]')?'#ff8c00':l.includes('[ERROR]')?'#ff3355':'#00e5ff';
    return `<div style="margin-bottom:1px"><span style="color:#253348">${esc(l.slice(0,11))}</span><span style="color:${col}">${esc(l.slice(11))}</span></div>`;
  }).join('');

  const tabs=['feed','pos','hist','log'];
  const tlb={feed:'📡 Feed',pos:'📊 Pos('+positions.length+')',hist:'📈 Hist('+tot+')',log:'🖥 Log'};
  const tc={feed:'#00ff88',pos:'#bb66ff',hist:'#f4c430',log:'#00e5ff'};

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>India Paper Trader — ${botMode}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}
.tabs{display:flex;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:9px 12px;font-weight:700;font-size:10px;border-bottom:3px solid transparent;color:#253348;white-space:nowrap;flex-shrink:0;text-decoration:none;display:block}
.pg{display:none;padding:11px}.pg.act{display:block}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.ld{width:5px;height:5px;border-radius:50%;background:${marketOpen?'#00ff88':'#253348'};box-shadow:0 0 5px ${marketOpen?'#00ff88':'#253348'};animation:bl 1.8s infinite;display:inline-block;vertical-align:middle}
.mbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:8px;font-family:monospace;font-size:9px;font-weight:700;text-decoration:none;border:1.5px solid;cursor:pointer;transition:opacity .15s}
</style>
</head><body>

<!-- TOPBAR -->
<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:8px 12px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-family:'Bebas Neue',cursive;font-size:14px;letter-spacing:2px;background:linear-gradient(90deg,#00ff88,#f4c430);-webkit-background-clip:text;-webkit-text-fill-color:transparent">INDIA PAPER TRADER</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:5px;border:1px solid rgba(0,229,255,.3);color:#00e5ff">📋 PAPER</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:5px;border:1px solid ${marketOpen?'rgba(0,255,136,.3)':'#253348'};color:${marketOpen?'#00ff88':'#5a6f96'}">${marketOpen?'● OPEN':'● CLOSED'}</span>
      ${isExpiry?'<span style="font-family:monospace;font-size:7px;padding:2px 6px;border-radius:5px;border:1px solid rgba(255,229,102,.3);color:#ffe566">⚡ EXPIRY</span>':''}
    </div>
    <div style="text-align:right">
      <div style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:#f4c430">₹${capital.toFixed(0)}</div>
      <div style="font-family:monospace;font-size:7px;color:#253348">${esc(ist)} · #${cycleCount}</div>
    </div>
  </div>
  <!-- MODE BUTTONS — always visible -->
  <div style="display:flex;align-items:center;gap:6px">
    <span style="font-family:monospace;font-size:8px;color:#253348">MODE:</span>
    <a href="/set?mode=AUTO&from=${tab}" class="mbtn" style="color:#00ff88;border-color:rgba(0,255,136,.4);background:${botMode==='AUTO'?'rgba(0,255,136,.18)':'rgba(0,255,136,.05)'}">🤖 AUTO</a>
    <a href="/set?mode=MANUAL&from=${tab}" class="mbtn" style="color:#f4c430;border-color:rgba(244,196,48,.4);background:${botMode==='MANUAL'?'rgba(244,196,48,.18)':'rgba(244,196,48,.05)'}">🎮 MANUAL</a>
    <a href="/set?mode=OFF&from=${tab}" class="mbtn" style="color:#ff3355;border-color:rgba(255,51,85,.4);background:${botMode==='OFF'?'rgba(255,51,85,.18)':'rgba(255,51,85,.05)'}">🛑 OFF</a>
    <span style="margin-left:auto;font-family:monospace;font-size:8px;color:${mc}">● ${botMode}</span>
  </div>
</div>

<!-- LIVE DATA ROW -->
<div style="display:flex;align-items:stretch;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto">
  ${[
    ['NIFTY',MD.nLTP,MD.changePct>=0?'#00ff88':'#ff3355'],
    ['CHANGE',(MD.changePct>=0?'+':'')+MD.changePct+'%',MD.changePct>=0?'#00ff88':'#ff3355'],
    ['VWAP',MD.nVWAP,'#00e5ff'],
    ['VIX',MD.vix.toFixed(1),MD.vix>25?'#ff3355':MD.vix>18?'#f4c430':'#00ff88'],
    ['RSI',MD.rsi.toFixed(0),MD.rsi>65?'#00ff88':MD.rsi<35?'#ff3355':'#f4c430'],
    ['Daily P&L',(dailyPnL>=0?'+':'')+'₹'+dailyPnL.toFixed(0),dailyPnL>=0?'#00ff88':'#ff3355']
  ].map(([n,v,c])=>`<div style="padding:5px 10px;border-right:1px solid #0f1624;white-space:nowrap;flex-shrink:0">
    <div style="font-family:monospace;font-size:7px;color:#253348;letter-spacing:1px">${n}</div>
    <div style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${c}">${v}</div>
  </div>`).join('')}
  <div style="margin-left:auto;padding:5px 8px;flex-shrink:0;display:flex;align-items:center;gap:3px">
    <span class="ld"></span>
    <span style="font-family:monospace;font-size:7px;color:${marketOpen?'#00ff88':'#5a6f96'}">${marketOpen?'LIVE':'WAIT'}</span>
  </div>
</div>

<!-- STATS -->
<div style="display:grid;grid-template-columns:repeat(4,1fr);background:#06080e;border-bottom:1px solid #0f1624">
  ${[
    ['P&L',(totalPnL>=0?'+':'')+'₹'+totalPnL.toFixed(0),pnlCol,'total'],
    ['Win%',tot?wr+'%':'—','#f4c430',tot?wins+'W '+losses+'L':'—'],
    ['Trades',tot,'#bb66ff',positions.length+' open'],
    ['Partials',partialExits,'#ffe566','50% exits']
  ].map(([l,v,c,s])=>`<div style="padding:6px 7px;border-right:1px solid #0f1624;last:border-right:none">
    <div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">${l}</div>
    <div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${c}">${v}</div>
    <div style="font-family:monospace;font-size:7px;color:#253348">${s}</div>
  </div>`).join('')}
</div>

<!-- STATUS BAR -->
<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 12px;background:#090b15;border-bottom:1px solid #0f1624;font-family:monospace;font-size:8px;color:#5a6f96">
  <span>Data: <strong style="color:#dde8ff">${esc(MD.dataSource)}</strong></span>
  <span>Last: <strong style="color:#dde8ff">${esc(lastFetch)}</strong></span>
  <span>Up: <strong style="color:#dde8ff">${up}m</strong></span>
</div>

<!-- TABS -->
<div class="tabs">${tabs.map(t=>`<a class="tab" href="/?tab=${t}" style="color:${tab===t?tc[t]:'#253348'};border-bottom:3px solid ${tab===t?tc[t]:'transparent'}">${tlb[t]}</a>`).join('')}</div>

<!-- FEED -->
<div class="pg ${tab==='feed'?'act':''}" id="pg-feed">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#253348;text-transform:uppercase">12 STRATEGIES · YAHOO FINANCE · PAPER ONLY</div>
    <a href="/?tab=feed" style="background:rgba(244,196,48,.08);border:1px solid rgba(244,196,48,.3);color:#f4c430;font-family:monospace;font-size:9px;padding:5px 12px;border-radius:6px;text-decoration:none">↻</a>
  </div>
  <!-- Market status card -->
  <div style="background:#090b15;border:1px solid ${marketOpen?'rgba(0,255,136,.2)':'#162030'};border-radius:10px;padding:11px;margin-bottom:10px">
    <div style="font-family:monospace;font-size:8px;color:${marketOpen?'#00ff88':'#5a6f96'};letter-spacing:2px;margin-bottom:6px">${marketOpen?'🟢 MARKET OPEN — BOT ACTIVE':'🔴 MARKET CLOSED — WAITING FOR 9:15 AM IST'}</div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.7">
      <strong style="color:#dde8ff">Hours:</strong> Mon–Fri 9:15 AM – 3:30 PM IST<br>
      <strong style="color:#dde8ff">Data:</strong> ${esc(MD.dataSource)} · Last: ${esc(lastFetch)}<br>
      <strong style="color:#dde8ff">Nifty:</strong> ${MD.nLTP} · VWAP: ${MD.nVWAP} · VIX: ${MD.vix.toFixed(1)}<br>
      <strong style="color:#dde8ff">Daily P&L limit:</strong> <span style="color:${dailyStop?'#ff3355':'#00ff88'}">${dailyStop?'⛔ HIT — no new trades':'✓ OK (3% limit)'}</span>
    </div>
  </div>
  ${feedHtml}
</div>

<div class="pg ${tab==='pos'?'act':''}" id="pg-pos">
  <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#253348;text-transform:uppercase;margin-bottom:8px;display:flex;justify-content:space-between">
    <span>PAPER POSITIONS — 5-PHASE ATR TRAIL</span><span style="color:#f4c430">${positions.length} open</span>
  </div>
  ${posHtml}
</div>

<div class="pg ${tab==='hist'?'act':''}" id="pg-hist">
  <div style="background:#090b15;border:1px solid #162030;border-radius:10px;padding:12px;margin-bottom:9px">
    <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#b8880a;margin-bottom:9px">PERFORMANCE (PAPER TRADING)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
      ${[
        ['Total P&L',(totalPnL>=0?'+':'')+'₹'+totalPnL.toFixed(0),pnlCol],
        ['Win Rate',tot?wr+'%':'—',wr>=55?'#00ff88':wr>=45?'#f4c430':'#ff3355'],
        ['Capital','₹'+capital.toFixed(0),'#f4c430'],
        ['Daily P&L',(dailyPnL>=0?'+':'')+'₹'+dailyPnL.toFixed(0),dailyPnL>=0?'#00ff88':'#ff3355'],
      ].map(([l,v,c])=>`<div style="padding:6px;background:#020409;border-radius:6px;border:1px solid #0f1624"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">${l}</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
    </div>
    <div style="font-family:monospace;font-size:8px;color:#253348;text-transform:uppercase;margin-bottom:5px">BY STRATEGY</div>
    ${stratBars||'<div style="font-family:monospace;font-size:9px;color:#253348">No trades yet. Waiting for market open.</div>'}
  </div>
  ${histHtml}
</div>

<div class="pg ${tab==='log'?'act':''}" id="pg-log">
  <a href="/?tab=log" style="background:rgba(244,196,48,.08);border:1px solid rgba(244,196,48,.3);color:#f4c430;font-family:monospace;font-size:9px;padding:5px 12px;border-radius:6px;text-decoration:none;display:inline-block;margin-bottom:10px">↻ REFRESH</a>
  <div style="background:#020408;border:1px solid #0f1624;border-radius:8px;padding:9px 11px;font-family:monospace;font-size:9px;line-height:1.8;max-height:420px;overflow-y:auto;color:#5a6f96">${logHtml||'<span style="color:#253348">No log yet.</span>'}</div>
</div>

<script>setTimeout(function(){window.location.reload();},30000);</script>
</body></html>`;
}

// ── HTTP SERVER ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if(url.pathname==='/health') {
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('OK paper v2 mode='+botMode+' market='+marketOpen+' nifty='+MD.nLTP+
            ' open='+positions.length+' closed='+closed.length+' cycle='+cycleCount);
    return;
  }
  if(url.pathname==='/set') {
    const p=url.searchParams, from=p.get('from')||'feed';
    if(p.has('mode')&&['AUTO','MANUAL','OFF'].includes(p.get('mode'))) {
      botMode=p.get('mode');
      tlog('INFO','Mode → '+botMode);
      addFeed(botMode==='AUTO'?'🤖':botMode==='MANUAL'?'🎮':'🛑',
        'MODE: '+botMode,
        botMode==='AUTO'?'Auto-trading resumed. Scanning every 30s.':
        botMode==='MANUAL'?'Auto-trading paused. Monitor mode.':
        'All trading stopped.',null,'info');
    }
    if(p.has('reset')&&p.get('reset')==='1') {
      positions=[];closed=[];capital=startCap;dailyPnL=0;weeklyPnL=0;
      dailyStop=false;cycleCount=0;feed=[];logs=[];partialExits=0;
      Object.keys(sS).forEach(k=>{sS[k]=0;sW[k]=0;});
      tlog('INFO','Reset done');
    }
    res.writeHead(302,{'Location':'/?tab='+from}); res.end(); return;
  }
  try {
    const tab=url.searchParams.get('tab')||'feed';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache, no-store'});
    res.end(buildPage(tab));
  } catch(e) {
    tlog('ERROR','build: '+e.message);
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('PAPER TRADER v2 RUNNING\nCycle:'+cycleCount+'\nNifty:'+MD.nLTP+'\nErr:'+e.message);
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  tlog('INFO','════════════════════════════════════════════');
  tlog('INFO',' INDIA PAPER TRADER v2 — PORT '+PORT);
  tlog('INFO','════════════════════════════════════════════');
  tlog('INFO','Data: Yahoo Finance (live Nifty, no API key)');
  tlog('INFO','Strategies: 12 active (TrendMom, EMACross, GapPlay, RSIRev,');
  tlog('INFO','  VWAPBounce, PivotReact, MACDCross, StrongClose, InsideBar,');
  tlog('INFO','  ExpiryPlay, HighVIX, WeekBreak)');
  tlog('INFO','Trail: 5-phase ATR + partial exit at +40%');
  tlog('INFO','Market: Mon-Fri 9:15 AM - 3:30 PM IST (auto-detected)');
  tlog('INFO','24x7: Runs on Render. Phone can be off.');
  tlog('INFO','Mode: AUTO (tap MANUAL or OFF to change in dashboard)');
  // Immediate first cycle, then every 30 seconds
  runCycle();
  setInterval(runCycle, 30000);
});
server.on('error', e => { console.error('FATAL:', e.message); process.exit(1); });
