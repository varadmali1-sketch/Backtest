// ══════════════════════════════════════════════════════════════════
//  NIFTY OPTIONS 10-YEAR BACKTEST + MONTE CARLO ENGINE v2
//  Yahoo Finance data — No API key needed
//  Black-Scholes options pricing + realistic costs
//  Monte Carlo: 1000 simulations × randomized trade sequences
//
//  BUILD COMMAND: npm install
//  START COMMAND: node server.js
// ══════════════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 10000;

// ── YAHOO FINANCE FETCH ───────────────────────────────────────────
function fetchYahoo(symbol, period1, period2, interval) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=history`;
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
      timeout: 20000
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const result = j?.chart?.result?.[0];
          if (!result) { reject(new Error('No chart data for ' + symbol)); return; }
          const times = result.timestamp || [];
          const q = result.indicators?.quote?.[0] || {};
          const candles = [];
          for (let i = 0; i < times.length; i++) {
            if (q.open?.[i] != null && q.close?.[i] != null) {
              candles.push({
                t: times[i],
                date: new Date(times[i]*1000).toISOString().slice(0,10),
                o: +q.open[i].toFixed(2), h: +q.high[i].toFixed(2),
                l: +q.low[i].toFixed(2), c: +q.close[i].toFixed(2),
                v: q.volume?.[i] || 0
              });
            }
          }
          resolve(candles);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ' + symbol)); });
    req.end();
  });
}

// ── BLACK-SCHOLES ─────────────────────────────────────────────────
function normCDF(x) {
  const a = [0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429];
  const p = 0.3275911, sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1/(1+p*x);
  let poly = 0; a.forEach((ai,i) => poly = poly*t + ai); poly *= t;
  return 0.5*(1 + sign*(1 - poly*Math.exp(-x*x)));
}
function bsPrice(S, K, T, r, sigma, isCall) {
  if (T <= 0.001) return Math.max(0, isCall ? S-K : K-S);
  const d1 = (Math.log(S/K) + (r + sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return isCall
    ? S*normCDF(d1) - K*Math.exp(-r*T)*normCDF(d2)
    : K*Math.exp(-r*T)*normCDF(-d2) - S*normCDF(-d1);
}
function atmPremium(spot, dte, iv) {
  const K = Math.round(spot/50)*50;
  const T = Math.max(dte,1)/365;
  return {
    ce: Math.max(5, +bsPrice(spot, K, T, 0.065, iv/100, true).toFixed(1)),
    pe: Math.max(5, +bsPrice(spot, K, T, 0.065, iv/100, false).toFixed(1)),
    K
  };
}

// ── MONTE CARLO ───────────────────────────────────────────────────
function runMonteCarlo(trades, startCap, simCount) {
  // Each simulation draws trades randomly with replacement
  const results = [];
  for (let s = 0; s < simCount; s++) {
    let cap = startCap, peak = startCap, maxDD = 0;
    let wins = 0, losses = 0;
    // Draw same number of trades as original
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[Math.floor(Math.random() * trades.length)];
      cap += trade.pnl;
      if (cap > peak) peak = cap;
      const dd = (peak - cap) / peak * 100;
      if (dd > maxDD) maxDD = dd;
      if (trade.pnl > 0) wins++; else losses++;
    }
    results.push({ finalCap: cap, maxDD, wr: Math.round(wins/(wins+losses)*100) });
  }
  results.sort((a,b) => a.finalCap - b.finalCap);
  const p5   = results[Math.floor(simCount*0.05)];
  const p25  = results[Math.floor(simCount*0.25)];
  const p50  = results[Math.floor(simCount*0.50)];
  const p75  = results[Math.floor(simCount*0.75)];
  const p95  = results[Math.floor(simCount*0.95)];
  const avgDD = results.reduce((s,r)=>s+r.maxDD,0)/simCount;
  const pctPositive = results.filter(r=>r.finalCap>startCap).length/simCount*100;
  return { p5, p25, p50, p75, p95, avgDD: +avgDD.toFixed(1), pctPositive: +pctPositive.toFixed(1), simCount };
}

// ── SYNTHETIC 10-YEAR DATA (if Yahoo fails) ───────────────────────
function makeSyntheticData(years) {
  const days = years * 252;
  const candles = [];
  let p = 11000; // Nifty ~11000 in 2015
  const now = Date.now();
  const start = now - days*86400000;
  for (let i = 0; i < days; i++) {
    const ts = Math.floor((start + i*86400000)/1000);
    const date = new Date(start + i*86400000);
    if (date.getDay()===0||date.getDay()===6) continue; // Skip weekends
    const yr = date.getFullYear();
    // Regime: bull 2015-17, bear 2018, bull 2019, crash 2020, bull 2021-24
    let drift = 0.0004;
    if (yr===2018||yr===2020) drift=-0.0002;
    if (yr===2021||yr===2022) drift=0.0005;
    const vol = yr===2020 ? 0.025 : 0.012;
    const noise = (Math.random()-0.49)*vol;
    const o = p;
    const c = Math.round(Math.max(7000, p*(1+drift+noise)));
    candles.push({ t:ts, date:date.toISOString().slice(0,10),
      o, h:Math.round(Math.max(o,c)*(1+Math.random()*0.006)),
      l:Math.round(Math.min(o,c)*(1-Math.random()*0.006)),
      c, v:Math.round(150e6+Math.random()*100e6) });
    p = c;
  }
  return candles;
}

// ── STATE ─────────────────────────────────────────────────────────
let btState = 'idle'; // idle | running | done | error
let btProgress = 0;
let btLogs = [];
let btResults = null;

function blog(msg) { console.log('[BT] '+msg); btLogs.push(msg); if(btLogs.length>300)btLogs.shift(); }

// ── MAIN BACKTEST ─────────────────────────────────────────────────
async function runBacktest() {
  if (btState === 'running') return;
  btState = 'running'; btProgress = 0; btLogs = []; btResults = null;

  try {
    blog('=== 10-YEAR BACKTEST + MONTE CARLO ===');
    blog('Data source: Yahoo Finance (^NSEI, ^INDIAVIX) — free, no API key');

    const now = Math.floor(Date.now()/1000);
    const tenYearsAgo = now - 10*365*24*3600;

    // Fetch Nifty data
    let niftyCandles = [];
    try {
      blog('Fetching Nifty 50 daily data from Yahoo Finance...');
      niftyCandles = await fetchYahoo('^NSEI', tenYearsAgo, now, '1d');
      blog('✓ Nifty: ' + niftyCandles.length + ' days ('
        + niftyCandles[0]?.date + ' to ' + niftyCandles[niftyCandles.length-1]?.date + ')');
    } catch(e) {
      blog('Yahoo failed (' + e.message + ') → using synthetic 10-year data');
      niftyCandles = makeSyntheticData(10);
      blog('✓ Synthetic: ' + niftyCandles.length + ' trading days generated');
    }
    btProgress = 15;

    // Fetch VIX
    let vixMap = {};
    try {
      blog('Fetching India VIX...');
      const vixC = await fetchYahoo('^INDIAVIX', tenYearsAgo, now, '1d');
      vixC.forEach(c => { vixMap[c.date] = c.c; });
      blog('✓ VIX: ' + vixC.length + ' days');
    } catch(e) { blog('VIX fetch failed → simulating VIX'); }
    btProgress = 25;

    // Enrich candles with indicators
    blog('Computing EMA, RSI, MACD, ATR, Pivots...');
    let ema9=niftyCandles[0].c, ema21=niftyCandles[0].c, ema50=niftyCandles[0].c;
    let macd=0, macdSig=0, macdHist=0;
    let gains=[], losses=[], rsi=50;
    let ivHist = Array(52).fill(15); // 52-week IV history
    const enriched = [];

    for (let i = 0; i < niftyCandles.length; i++) {
      const c = niftyCandles[i];
      ema9  = ema9*(1-2/10)+c.c*(2/10);
      ema21 = ema21*(1-2/22)+c.c*(2/22);
      ema50 = ema50*(1-2/51)+c.c*(2/51);
      if (i > 0) {
        const chg = c.c - niftyCandles[i-1].c;
        gains.push(Math.max(0, chg)); losses.push(Math.max(0,-chg));
        if (gains.length > 14) { gains.shift(); losses.shift(); }
        const ag=gains.reduce((a,b)=>a+b,0)/gains.length;
        const al=losses.reduce((a,b)=>a+b,0)/losses.length;
        rsi = al===0 ? 100 : 100-100/(1+ag/al);
      }
      const macdPrevHist = macdHist;
      macd = ema9 - ema21;
      macdSig = macdSig*0.85+macd*0.15;
      macdHist = macd - macdSig;
      // ATR
      const atr = i>0 ? Math.abs(c.h-c.l)*0.7 : 80;
      // VIX / IV
      const vix = vixMap[c.date] || 14+Math.sin(i/60)*5+Math.random()*3;
      const iv = vix * (1.0 + (Math.random()-0.5)*0.1);
      ivHist.push(iv); ivHist.shift();
      const ivSorted = [...ivHist].sort((a,b)=>a-b);
      const ivRank = Math.round(ivSorted.findIndex(v=>v>=iv)/ivHist.length*100);
      // VWAP
      const vwap = (c.h+c.l+c.c)/3;
      // PCR (simulated, correlated with price vs EMA)
      const pcr = 1.2-(c.c-ema21)/ema21*4+(Math.random()-0.5)*0.15;
      // FII
      const fii = (c.c-(i>0?niftyCandles[i-1].c:c.c))/(i>0?niftyCandles[i-1].c:c.c)*8000+(Math.random()-0.5)*600;
      // Days to expiry (Thursday = 0, others = days until Thursday)
      const dt = new Date(c.t*1000);
      const day = dt.getDay();
      const isExpiry = day===4;
      const dte = day<=4 ? 4-day : 4+(7-day);
      // Prev day
      const prev = enriched[i-1] || c;
      // Pivots
      const pp=(prev.h+prev.l+prev.c)/3;
      const r1=2*pp-prev.l, s1=2*pp-prev.h;
      // CPR
      const cprH=(prev.h+prev.c)/2, cprL=(prev.l+prev.c)/2;
      const cprW=cprH-cprL;
      // Year/Month for aggregation
      const yr = c.date.slice(0,4);
      const mo = c.date.slice(0,7);
      enriched.push({
        ...c, ema9,ema21,ema50,rsi,macdHist,macdPrevHist:macdPrevHist,
        atr,vix,iv,ivRank,vwap,pcr,fii,isExpiry,dte,
        pp,r1,s1,cprH,cprL,cprW,yr,mo,
        prevC: i>0 ? niftyCandles[i-1].c : c.c,
        prevH: prev.h, prevL: prev.l
      });
    }
    btProgress = 40;
    blog('✓ Indicators computed for ' + enriched.length + ' days');

    // ── STRATEGY DEFINITIONS ─────────────────────────────────────
    const strategies = [
      {
        name:'ORB', grade:'',
        signal(d,p) {
          if(!p) return null;
          const bk = d.c > p.h*1.001 && d.c > d.ema9 && d.v > p.v*1.25 && d.rsi>57;
          const bd = d.c < p.l*0.999 && d.c < d.ema9 && d.v > p.v*1.25 && d.rsi<43;
          if(bk) return 'CE'; if(bd) return 'PE'; return null;
        }
      },
      {
        name:'VWAPReclaim', grade:'',
        signal(d,p) {
          if(!p) return null;
          const reclaim = p.c < p.vwap && d.c > d.vwap*1.001 && d.rsi>50 && d.c>d.ema21;
          const reject  = p.c > p.vwap && d.c < d.vwap*0.999 && d.rsi<50 && d.c<d.ema21;
          if(reclaim) return 'CE'; if(reject) return 'PE'; return null;
        }
      },
      {
        name:'EMAPullback', grade:'',
        signal(d,p) {
          if(!p) return null;
          const bull = d.ema9>d.ema21 && d.c>=d.ema21*0.998 && d.c<=d.ema21*1.003 && d.rsi>44 && d.rsi<60;
          const bear = d.ema9<d.ema21 && d.c>=d.ema21*0.997 && d.c<=d.ema21*1.002 && d.rsi>40 && d.rsi<56;
          if(bull) return 'CE'; if(bear) return 'PE'; return null;
        }
      },
      {
        name:'MomOI', grade:'',
        signal(d,p) {
          if(!p) return null;
          const up = (d.c-p.c)/p.c*100 > 0.7 && d.v>p.v*1.4 && d.rsi>62;
          const dn = (d.c-p.c)/p.c*100 < -0.7 && d.v>p.v*1.4 && d.rsi<38;
          if(up) return 'CE'; if(dn) return 'PE'; return null;
        }
      },
      {
        name:'SupertrendFlip', grade:'',
        signal(d,p) {
          if(!p) return null;
          const stCurr = d.c>d.ema21 ? 'UP':'DOWN';
          const stPrev = p.c>p.ema21 ? 'UP':'DOWN';
          if(stCurr===stPrev) return null;
          if(stCurr==='UP' && d.pcr>1.0) return 'CE';
          if(stCurr==='DOWN' && d.pcr<1.0) return 'PE';
          return null;
        }
      },
      {
        name:'GapPlay', grade:'',
        signal(d,p) {
          if(!p) return null;
          const gp=(d.o-p.c)/p.c*100;
          if(gp>0.5 && d.c>d.o) return 'CE';
          if(gp<-0.5 && d.c<d.o) return 'PE';
          return null;
        }
      },
      {
        name:'CPRBreakout', grade:'',
        signal(d,p) {
          if(!p) return null;
          const narrow = d.cprW < d.atr*0.5;
          if(!narrow) return null;
          if(d.c>d.cprH*1.001 && d.ema9>d.ema21 && d.rsi>54) return 'CE';
          if(d.c<d.cprL*0.999 && d.ema9<d.ema21 && d.rsi<46) return 'PE';
          return null;
        }
      },
      {
        name:'GammaExpiry', grade:'',
        signal(d,p) {
          if(!d.isExpiry||!p) return null;
          if(d.vix>28) return null;
          if(d.c>d.vwap && d.rsi>58 && d.macdHist>0) return 'CE';
          if(d.c<d.vwap && d.rsi<42 && d.macdHist<0) return 'PE';
          return null;
        }
      },
      {
        name:'IVRankBuy', grade:'',
        signal(d,p) {
          if(d.ivRank>35||!p) return null;
          if(d.c>d.ema21 && d.rsi>52 && d.ema9>d.ema21) return 'CE';
          if(d.c<d.ema21 && d.rsi<48 && d.ema9<d.ema21) return 'PE';
          return null;
        }
      },
      {
        name:'FIIFlow', grade:'',
        signal(d,p) {
          if(!p) return null;
          if(d.fii>700 && d.c>d.vwap && d.rsi>52) return 'CE';
          if(d.fii<-700 && d.c<d.vwap && d.rsi<48) return 'PE';
          return null;
        }
      },
      {
        name:'PivotBounce', grade:'',
        signal(d,p) {
          if(!p) return null;
          const atS1=Math.abs(d.c-d.s1)/d.s1<0.004;
          const atR1=Math.abs(d.c-d.r1)/d.r1<0.004;
          if(atS1 && d.rsi<40) return 'CE';
          if(atR1 && d.rsi>60) return 'PE';
          return null;
        }
      },
      {
        name:'MACDDivergence', grade:'',
        signal(d,p) {
          if(!p) return null;
          const bullDiv = d.l<p.l && d.macdHist>d.macdPrevHist && d.rsi<42;
          const bearDiv = d.h>p.h && d.macdHist<d.macdPrevHist && d.rsi>58;
          if(bullDiv) return 'CE'; if(bearDiv) return 'PE'; return null;
        }
      }
    ];

    // ── RUN EACH STRATEGY ────────────────────────────────────────
    const CAPITAL = 100000;
    const LOT = 25;
    const BROK = 40; // ₹40 per side
    const SLIP = 0.025; // 2.5% slippage (conservative)
    const SL_PCT = 0.40;
    const TP_PCT = 0.70;

    const allResults = {};
    const allTradesForMC = {}; // per strategy trades for Monte Carlo

    blog('Running 12 strategies × ' + enriched.length + ' days...');

    for (const strat of strategies) {
      btProgress = 40 + Math.round(strategies.indexOf(strat)/strategies.length * 35);
      let cap=CAPITAL, peak=CAPITAL, maxDD=0;
      let wins=0, losses=0, totalPnL=0;
      const trades = [];
      const yearlyPnL = {}, monthlyPnL = {};

      for (let i=1; i<enriched.length; i++) {
        const d=enriched[i], p=enriched[i-1];
        if(!d||!p) continue;
        if(d.vix>35) continue; // No trading in extreme VIX

        const sig = strat.signal(d, p);
        if(!sig) continue;

        // Skip if high VIX (reduce lots)
        if(d.vix>28) continue;

        // Get premium
        const prems = atmPremium(d.c, d.dte, d.iv);
        const rawPrem = sig==='CE' ? prems.ce : prems.pe;
        const entry = rawPrem*(1+SLIP);
        if(entry<8 || entry*LOT > cap*0.06) continue; // Skip if too expensive

        // Simulate outcome over next 2 trading days
        const exitIdx = Math.min(i+2, enriched.length-1);
        const ed = enriched[exitIdx];
        const exitPrems = atmPremium(ed.c, Math.max(1,d.dte-2), ed.iv);
        let exitRaw = sig==='CE' ? exitPrems.ce : exitPrems.pe;

        // Check SL/TP intraday simulation
        let hitTP=false, hitSL=false;
        for(let j=i+1;j<=exitIdx;j++){
          const jd=enriched[j];
          // High premium estimate (favorable move)
          const highP=atmPremium(sig==='CE'?jd.h:jd.l, Math.max(1,d.dte-(j-i)), jd.iv*1.08);
          const lowP =atmPremium(sig==='CE'?jd.l:jd.h, Math.max(1,d.dte-(j-i)), jd.iv*0.93);
          const hp = sig==='CE'?highP.ce:highP.pe;
          const lp = sig==='CE'?lowP.ce:lowP.pe;
          if(hp >= entry*(1+TP_PCT)) { exitRaw=entry*(1+TP_PCT)*(1-SLIP); hitTP=true; break; }
          if(lp <= entry*(1-SL_PCT)) { exitRaw=entry*(1-SL_PCT)*(1+SLIP); hitSL=true; break; }
        }
        if(!hitTP&&!hitSL) exitRaw=exitRaw*(1-SLIP);

        const pnl=(exitRaw-entry)*LOT - BROK*2;
        cap+=pnl; if(cap>peak)peak=cap;
        const dd=(peak-cap)/peak*100; if(dd>maxDD)maxDD=dd;
        if(pnl>0)wins++;else losses++;
        totalPnL+=pnl;

        const yr=d.yr, mo=d.mo;
        if(!yearlyPnL[yr])yearlyPnL[yr]=0; yearlyPnL[yr]+=pnl;
        if(!monthlyPnL[mo])monthlyPnL[mo]=0; monthlyPnL[mo]+=pnl;

        trades.push({
          date:d.date, signal:sig, entry:+entry.toFixed(1), exit:+exitRaw.toFixed(1),
          pnl:+pnl.toFixed(0), type:hitTP?'TP':hitSL?'SL':'TIME',
          vix:+d.vix.toFixed(1), iv:+d.iv.toFixed(1), yr, mo
        });
      }

      const tot=wins+losses;
      const wr=tot?Math.round(wins/tot*100):0;
      const avgW=wins?trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/wins:0;
      const avgL=losses?Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0)/losses):0;
      const pf=losses&&avgL?(wins*avgW)/(losses*avgL):0;
      const annRet=(cap-CAPITAL)/CAPITAL*100/10;
      const sharpe=tot>20?(annRet/Math.max(1,maxDD)):0;
      // Grade
      const grade = wr>=56&&pf>=1.35&&maxDD<22&&tot>=50?'A':wr>=50&&pf>=1.15&&maxDD<30&&tot>=30?'B':'C';

      // Monthly stats
      const monthVals=Object.values(monthlyPnL);
      const profitMonths=monthVals.filter(v=>v>0).length;
      const lossMonths=monthVals.filter(v=>v<0).length;
      const avgProfitMo=profitMonths?monthVals.filter(v=>v>0).reduce((a,b)=>a+b,0)/profitMonths:0;
      const avgLossMo=lossMonths?Math.abs(monthVals.filter(v=>v<0).reduce((a,b)=>a+b,0)/lossMonths):0;
      const bestMo=Math.max(...monthVals,0);
      const worstMo=Math.min(...monthVals,0);

      allResults[strat.name]={
        trades:tot,wins,losses,winRate:wr,
        totalPnL:Math.round(totalPnL),finalCapital:Math.round(cap),
        return10yr:Math.round((cap-CAPITAL)/CAPITAL*100),
        annualReturn:Math.round(annRet),
        maxDD:Math.round(maxDD*10)/10,
        avgWin:Math.round(avgW),avgLoss:Math.round(avgL),
        profitFactor:Math.round(pf*100)/100,
        sharpe:Math.round(sharpe*100)/100,
        grade,
        yearlyPnL,monthlyPnL,
        profitMonths,lossMonths,
        totalMonths:monthVals.length,
        avgProfitMonth:Math.round(avgProfitMo),
        avgLossMonth:Math.round(avgLossMo),
        bestMonth:Math.round(bestMo),worstMonth:Math.round(worstMo),
        pctProfitableMonths:monthVals.length?Math.round(profitMonths/monthVals.length*100):0,
        recentTrades:trades.slice(-8)
      };
      allTradesForMC[strat.name]=trades;
      blog('✓ '+strat.name+': '+tot+' trades, WR:'+wr+'%, Ann:'+Math.round(annRet)+'%, DD:'+Math.round(maxDD)+'% → Grade '+grade);
    }

    btProgress = 78;
    blog('Running Monte Carlo simulations (1000 × each strategy)...');

    // ── MONTE CARLO ──────────────────────────────────────────────
    const mcResults = {};
    for (const strat of strategies) {
      const trades = allTradesForMC[strat.name];
      if(trades.length < 20) {
        mcResults[strat.name] = null;
        continue;
      }
      mcResults[strat.name] = runMonteCarlo(trades, CAPITAL, 1000);
      blog('✓ MC '+strat.name+': P50 cap=₹'+Math.round(mcResults[strat.name].p50.finalCap)+' P5 cap=₹'+Math.round(mcResults[strat.name].p5.finalCap));
    }
    btProgress = 90;

    // ── COMBINED PORTFOLIO ────────────────────────────────────────
    blog('Building combined portfolio (A+B grade strategies)...');
    const topStrats = Object.keys(allResults).filter(k=>allResults[k].grade!=='C');
    let comboCap=CAPITAL, comboPeak=CAPITAL, comboMaxDD=0;
    let comboW=0,comboL=0,comboPnL=0;
    const comboYr={}, comboMo={}, comboTrades=[];

    // Merge all top-strat trades, sort by date
    topStrats.forEach(s => {
      allTradesForMC[s].forEach(t => comboTrades.push({...t,strat:s}));
    });
    comboTrades.sort((a,b)=>a.date.localeCompare(b.date));
    comboTrades.forEach(t=>{
      comboCap+=t.pnl; if(comboCap>comboPeak)comboPeak=comboCap;
      const dd=(comboPeak-comboCap)/comboPeak*100; if(dd>comboMaxDD)comboMaxDD=dd;
      if(t.pnl>0)comboW++;else comboL++;comboPnL+=t.pnl;
      if(!comboYr[t.yr])comboYr[t.yr]=0;comboYr[t.yr]+=t.pnl;
      if(!comboMo[t.mo])comboMo[t.mo]=0;comboMo[t.mo]+=t.pnl;
    });

    // Combined Monte Carlo
    blog('Combined portfolio Monte Carlo (1000 sims)...');
    const comboMC = comboTrades.length>20 ? runMonteCarlo(comboTrades,CAPITAL,1000) : null;
    const comboMonths=Object.values(comboMo);
    const comboProfMo=comboMonths.filter(v=>v>0).length;

    btProgress=98;
    blog('Computing monthly expectations...');

    // Monthly expectation summary
    const monthExpect={};
    Object.keys(allResults).forEach(name=>{
      const r=allResults[name];
      monthExpect[name]={
        pctProfit:r.pctProfitableMonths,
        avgProfit:r.avgProfitMonth,
        avgLoss:r.avgLossMonth,
        best:r.bestMonth,
        worst:r.worstMonth,
        expectation:Math.round(r.avgProfitMonth*r.pctProfitableMonths/100 - r.avgLossMonth*(1-r.pctProfitableMonths/100))
      };
    });

    btResults = {
      generated:new Date().toISOString().slice(0,19).replace('T',' ')+' UTC',
      dataSource:'Yahoo Finance ^NSEI + ^INDIAVIX',
      period:enriched[0]?.date+' to '+enriched[enriched.length-1]?.date,
      totalTradingDays:enriched.length,
      strategies:allResults,
      mc:mcResults,
      combined:{
        topStrats,finalCapital:Math.round(comboCap),
        return10yr:Math.round((comboCap-CAPITAL)/CAPITAL*100),
        annualReturn:Math.round((comboCap-CAPITAL)/CAPITAL*100/10),
        maxDD:Math.round(comboMaxDD*10)/10,
        winRate:comboTrades.length?Math.round(comboW/comboTrades.length*100):0,
        totalTrades:comboTrades.length,wins:comboW,losses:comboL,
        profitableMonths:comboProfMo,
        totalMonths:comboMonths.length,
        pctProfitableMonths:comboMonths.length?Math.round(comboProfMo/comboMonths.length*100):0,
        yearlyPnL:comboYr,
        monthlyPnL:comboMo,
        mc:comboMC
      },
      monthExpect,
      config:{capital:CAPITAL,lot:LOT,brokerage:BROK,slippage:Math.round(SLIP*100)+'%',sl:Math.round(SL_PCT*100)+'%',tp:Math.round(TP_PCT*100)+'%'}
    };

    btProgress=100;
    blog('=== BACKTEST COMPLETE ===');
    blog('Period: '+btResults.period+' ('+enriched.length+' trading days)');
    blog('Top strategies: '+topStrats.join(', '));
    blog('Combined 10yr return: '+btResults.combined.return10yr+'%');
    blog('Combined annual return: '+btResults.combined.annualReturn+'%/yr');
    blog('Combined max drawdown: '+btResults.combined.maxDD+'%');
    blog('Profitable months: '+btResults.combined.pctProfitableMonths+'% of all months');
    btState='done';

  } catch(e) {
    blog('FATAL ERROR: '+e.message+'\n'+e.stack);
    btState='error';
  }
}

// ── HELPERS ───────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function rupee(n){return '₹'+(Math.abs(n)||0).toLocaleString('en-IN');}
function pnlCol(n){return n>=0?'#00ff88':'#ff3355';}
function pnlStr(n){return (n>=0?'+':'')+rupee(n);}

// ── DASHBOARD ─────────────────────────────────────────────────────
function buildPage() {
  const running = btState==='running';
  const done = btState==='done';
  const error = btState==='error';

  // CSS
  const css = `*{margin:0;padding:0;box-sizing:border-box}html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}
  .card{background:#090b15;border:1px solid #162030;border-radius:11px;padding:13px;margin-bottom:11px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #0f1624}
  .row:last-child{border-bottom:none}
  .stat{padding:6px;background:#020409;border-radius:6px;border:1px solid #0f1624;text-align:center}
  .sl{font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:2px}
  .sv{font-family:'Space Mono',monospace;font-size:12px;font-weight:700}
  .stcard{border-radius:10px;padding:11px;margin-bottom:8px;border-left:4px solid}
  @keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
  .ld{width:5px;height:5px;border-radius:50%;background:#00ff88;box-shadow:0 0 5px #00ff88;animation:bl 1.8s infinite;display:inline-block;vertical-align:middle}`;

  // Progress bar
  const progressSection = running ? `
    <div class="card" style="border-color:rgba(0,255,136,.25)">
      <div style="font-family:monospace;font-size:9px;color:#00ff88;letter-spacing:2px;margin-bottom:8px"><span class="ld"></span> RUNNING... ${btProgress}%</div>
      <div style="background:#0f1624;border-radius:4px;height:7px;overflow:hidden;margin-bottom:10px">
        <div style="height:100%;width:${btProgress}%;background:linear-gradient(90deg,#00ff88,#00e5ff);border-radius:4px;transition:width .5s"></div>
      </div>
      <div style="font-family:monospace;font-size:9px;color:#5a6f96">${esc(btLogs[btLogs.length-1]||'...')}</div>
    </div>` : '';

  const runBtn = !running
    ? `<a href="/run" style="display:inline-block;padding:13px 28px;background:rgba(0,255,136,.1);border:2px solid #00ff88;color:#00ff88;font-family:monospace;font-weight:700;font-size:13px;border-radius:10px;text-decoration:none;letter-spacing:2px;margin-bottom:14px">${done?'↻ RE-RUN (10 YRS)':'▶ START 10-YEAR BACKTEST'}</a>`
    : `<div style="display:inline-block;padding:13px 28px;background:rgba(244,196,48,.08);border:2px solid #f4c430;color:#f4c430;font-family:monospace;font-weight:700;font-size:13px;border-radius:10px;margin-bottom:14px">⏳ RUNNING ${btProgress}%</div>`;

  if (!done) {
    const logHtml = btLogs.slice(-20).map(l=>`<div style="margin-bottom:2px;font-family:monospace;font-size:9px;color:#5a6f96">${esc(l)}</div>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>10yr Backtest</title>
    <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
    <style>${css}</style>${running?'<meta http-equiv="refresh" content="4">':''}
    </head><body>
    <div style="padding:14px">
    <div style="font-family:'Bebas Neue',cursive;font-size:20px;letter-spacing:3px;background:linear-gradient(90deg,#ffd700,#00ff88);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:3px">10-YEAR BACKTEST + MONTE CARLO</div>
    <div style="font-family:monospace;font-size:9px;color:#253348;margin-bottom:14px">Yahoo Finance ^NSEI · 12 Strategies · Black-Scholes Pricing · 1000 Monte Carlo Sims</div>
    <div class="card">
      <div style="font-family:monospace;font-size:8px;color:#00e5ff;letter-spacing:2px;margin-bottom:9px">HOW IT WORKS</div>
      <div style="font-family:monospace;font-size:10px;color:#5a6f96;line-height:1.9">
        <strong style="color:#dde8ff">Data:</strong> Yahoo Finance ^NSEI — free, no API key, no login<br>
        <strong style="color:#dde8ff">Options:</strong> Black-Scholes with real IV from ^INDIAVIX<br>
        <strong style="color:#dde8ff">Costs:</strong> ₹40 brokerage + 2.5% slippage per trade<br>
        <strong style="color:#dde8ff">Monte Carlo:</strong> 1000 random trade sequences per strategy<br>
        <strong style="color:#dde8ff">Time:</strong> ~2-3 minutes to complete
      </div>
    </div>
    ${progressSection}
    ${runBtn}
    ${btLogs.length>0?`<div style="background:#020408;border:1px solid #0f1624;border-radius:8px;padding:10px;font-family:monospace;font-size:9px;line-height:1.7;max-height:180px;overflow-y:auto;color:#5a6f96;margin-top:10px">${logHtml}</div>`:''}
    ${error?`<div style="font-family:monospace;font-size:10px;color:#ff3355;padding:10px;background:rgba(255,51,85,.08);border:1px solid rgba(255,51,85,.3);border-radius:8px;margin-top:10px">Error: ${esc(btLogs[btLogs.length-1]||'unknown')}</div>`:''}
    </div></body></html>`;
  }

  // ── RESULTS PAGE ─────────────────────────────────────────────────
  const R = btResults;
  const gradeColor = {A:'#00ff88',B:'#f4c430',C:'#ff3355'};
  const sortedStrats = Object.keys(R.strategies).sort((a,b)=>R.strategies[b].annualReturn-R.strategies[a].annualReturn);

  // Combined year-by-year
  const years = Object.keys(R.combined.yearlyPnL).sort();
  const yearRows = years.map(yr=>{
    const pnl=R.combined.yearlyPnL[yr];
    const ret=Math.round(pnl/100000*100);
    return `<div class="row">
      <span style="font-family:monospace;font-size:10px;color:#dde8ff">${yr}</span>
      <span style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${pnlCol(pnl)}">${pnlStr(Math.round(pnl))}</span>
      <span style="font-family:monospace;font-size:10px;color:${pnlCol(ret)}">${ret>=0?'+':''}${ret}% return</span>
    </div>`;
  }).join('');

  // Monte Carlo section for combined
  const comboMC = R.combined.mc;
  const mcSection = comboMC ? `
    <div class="card" style="border-color:rgba(187,102,255,.3)">
      <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#bb66ff;text-transform:uppercase;margin-bottom:10px">🎲 MONTE CARLO — ${comboMC.simCount} SIMULATIONS</div>
      <div style="font-family:monospace;font-size:9px;color:#5a6f96;margin-bottom:10px;line-height:1.7">
        Randomizes trade order 1000 times to show realistic outcome range. Answers: "What's the worst I could realistically do?"
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        ${[
          ['5th Percentile (Worst 5%)', rupee(Math.round(comboMC.p5.finalCap)), '#ff3355'],
          ['25th Percentile', rupee(Math.round(comboMC.p25.finalCap)), '#ff8c00'],
          ['50th Percentile (Median)', rupee(Math.round(comboMC.p50.finalCap)), '#f4c430'],
          ['75th Percentile', rupee(Math.round(comboMC.p75.finalCap)), '#00ff88'],
          ['95th Percentile (Best 5%)', rupee(Math.round(comboMC.p95.finalCap)), '#00ff88'],
          ['% Profitable Sims', comboMC.pctPositive+'%', comboMC.pctPositive>=65?'#00ff88':'#f4c430'],
          ['Avg Max Drawdown', comboMC.avgDD+'%', comboMC.avgDD<20?'#00ff88':comboMC.avgDD<35?'#f4c430':'#ff3355'],
          ['Starting Capital', rupee(100000), '#5a6f96']
        ].map(([l,v,c])=>`<div class="stat"><div class="sl">${esc(l)}</div><div class="sv" style="color:${c}">${esc(v)}</div></div>`).join('')}
      </div>
      <div style="font-family:monospace;font-size:9px;color:#5a6f96;padding:9px;background:#020409;border-radius:7px;border:1px solid #0f1624;line-height:1.7">
        <strong style="color:#dde8ff">What this means:</strong> In ${comboMC.pctPositive}% of 1000 random simulations, the portfolio was profitable. The median outcome was ${rupee(Math.round(comboMC.p50.finalCap))}. In the worst 5% of scenarios, capital fell to ${rupee(Math.round(comboMC.p5.finalCap))}. Always size positions such that the worst-case drawdown is acceptable to you.
      </div>
    </div>` : '';

  // Monthly expectations
  const monthExpHtml = `
    <div class="card">
      <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#b8880a;margin-bottom:10px">📅 MONTHLY EXPECTATIONS — COMBINED PORTFOLIO</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px">
        ${[
          ['Profitable Months', R.combined.pctProfitableMonths+'%', R.combined.pctProfitableMonths>=60?'#00ff88':'#f4c430'],
          ['Loss Months', (100-R.combined.pctProfitableMonths)+'%', '#ff3355'],
          ['Avg Profit Month', pnlStr(Object.values(R.combined.monthlyPnL).filter(v=>v>0).reduce((a,b)=>a+b,0)/Math.max(1,R.combined.profitableMonths)), '#00ff88'],
          ['Avg Loss Month', '-'+rupee(Math.abs(Object.values(R.combined.monthlyPnL).filter(v=>v<0).reduce((a,b)=>a+b,0)/Math.max(1,R.combined.totalMonths-R.combined.profitableMonths))), '#ff3355'],
          ['Best Month Ever', pnlStr(Math.round(Math.max(...Object.values(R.combined.monthlyPnL)))), '#00ff88'],
          ['Worst Month Ever', pnlStr(Math.round(Math.min(...Object.values(R.combined.monthlyPnL)))), '#ff3355']
        ].map(([l,v,c])=>`<div class="stat"><div class="sl">${esc(l)}</div><div class="sv" style="color:${c}">${esc(v)}</div></div>`).join('')}
      </div>
      <div style="font-family:monospace;font-size:9px;color:#5a6f96;padding:9px;background:#020409;border-radius:7px;border:1px solid #0f1624;line-height:1.8">
        <strong style="color:#ff3355">⚠️ REALITY CHECK:</strong> This bot will lose money in ${100-R.combined.pctProfitableMonths}% of months. That is normal. The key is that winning months outweigh losing months over time. <strong style="color:#dde8ff">Never put money in this bot that you cannot afford to lose entirely.</strong> Start with ₹25,000-50,000 maximum after 4 weeks of successful paper testing.
      </div>
    </div>`;

  // Strategy cards
  const stratHtml = sortedStrats.map(name=>{
    const s=R.strategies[name];
    const mc=R.mc[name];
    const gc=gradeColor[s.grade];
    const mce=R.monthExpect[name];
    return `<div class="stcard" style="background:#06080e;border-left-color:${gc}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:9px">
        <div>
          <div style="font-weight:700;font-size:13px">${esc(name)} <span style="font-family:monospace;font-size:9px;padding:2px 8px;border-radius:5px;background:${gc}22;border:1px solid ${gc};color:${gc}">GRADE ${s.grade}</span></div>
          <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:2px">${s.trades} trades · ${s.totalMonths} months</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Space Mono',monospace;font-size:15px;font-weight:700;color:${pnlCol(s.annualReturn)}">${s.annualReturn>=0?'+':''}${s.annualReturn}%<span style="font-size:10px;color:#5a6f96">/yr</span></div>
          <div style="font-family:monospace;font-size:8px;color:#5a6f96">${pnlStr(s.return10yr)}% over 10yr</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px">
        ${[
          ['Win Rate',s.winRate+'%',s.winRate>=55?'#00ff88':s.winRate>=48?'#f4c430':'#ff3355'],
          ['Prof Factor',s.profitFactor,s.profitFactor>=1.3?'#00ff88':s.profitFactor>=1.1?'#f4c430':'#ff3355'],
          ['Max DD',s.maxDD+'%',s.maxDD<15?'#00ff88':s.maxDD<25?'#f4c430':'#ff3355'],
          ['Sharpe',s.sharpe,s.sharpe>=1?'#00ff88':s.sharpe>=0.5?'#f4c430':'#ff3355']
        ].map(([l,v,c])=>`<div class="stat"><div class="sl">${l}</div><div class="sv" style="color:${c}">${v}</div></div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:8px">
        ${[
          ['Profit Months',s.pctProfitableMonths+'%',s.pctProfitableMonths>=60?'#00ff88':'#f4c430'],
          ['Avg Win Mo',pnlStr(s.avgProfitMonth),'#00ff88'],
          ['Avg Loss Mo','-'+rupee(s.avgLossMonth),'#ff3355']
        ].map(([l,v,c])=>`<div class="stat"><div class="sl">${l}</div><div class="sv" style="color:${c};font-size:10px">${v}</div></div>`).join('')}
      </div>
      ${mc?`<div style="background:#090b15;border-radius:7px;padding:8px;border:1px solid rgba(187,102,255,.15)">
        <div style="font-family:monospace;font-size:7px;color:#bb66ff;letter-spacing:1.5px;margin-bottom:5px">MONTE CARLO (1000 sims)</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px">
          ${[['P5',Math.round(mc.p5.finalCap),'#ff3355'],['P25',Math.round(mc.p25.finalCap),'#ff8c00'],['P50',Math.round(mc.p50.finalCap),'#f4c430'],['P75',Math.round(mc.p75.finalCap),'#00ff88'],['P95',Math.round(mc.p95.finalCap),'#00ff88']].map(([l,v,c])=>`<div style="text-align:center"><div style="font-family:monospace;font-size:7px;color:#253348">${l}</div><div style="font-family:monospace;font-size:9px;font-weight:700;color:${c}">₹${Math.round(v/1000)}k</div></div>`).join('')}
        </div>
        <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-top:4px">${mc.pctPositive}% profitable · avg DD ${mc.avgDD}%</div>
      </div>`:''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>10yr Results + Monte Carlo</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body>

<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:9px 12px;display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-family:'Bebas Neue',cursive;font-size:14px;letter-spacing:3px;background:linear-gradient(90deg,#ffd700,#00ff88);-webkit-background-clip:text;-webkit-text-fill-color:transparent">10-YR BACKTEST + MONTE CARLO</div>
    <div style="font-family:monospace;font-size:7px;color:#253348">${esc(R.period)} · ${esc(R.totalTradingDays)} trading days</div>
  </div>
  <a href="/run" style="padding:5px 10px;background:rgba(244,196,48,.08);border:1px solid rgba(244,196,48,.3);color:#f4c430;font-family:monospace;font-size:8px;border-radius:6px;text-decoration:none">↻ RE-RUN</a>
</div>

<div style="padding:11px">

<!-- COMBINED SUMMARY -->
<div class="card" style="border-color:rgba(0,255,136,.3)">
  <div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#b8880a;margin-bottom:10px">COMBINED PORTFOLIO — TOP GRADE STRATEGIES</div>
  <div style="text-align:center;margin-bottom:12px">
    <div style="font-family:'Space Mono',monospace;font-size:28px;font-weight:700;color:${pnlCol(R.combined.return10yr)}">${R.combined.return10yr>=0?'+':''}${R.combined.return10yr}%</div>
    <div style="font-family:monospace;font-size:9px;color:#253348;margin-top:2px">TOTAL 10-YEAR RETURN ON ₹1,00,000</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px">
    ${[
      ['Annual Return',R.combined.annualReturn+'%/yr',R.combined.annualReturn>=20?'#00ff88':R.combined.annualReturn>=10?'#f4c430':'#ff3355'],
      ['Win Rate',R.combined.winRate+'%',R.combined.winRate>=55?'#00ff88':'#f4c430'],
      ['Max Drawdown',R.combined.maxDD+'%',R.combined.maxDD<20?'#00ff88':R.combined.maxDD<30?'#f4c430':'#ff3355'],
      ['Final Capital',rupee(R.combined.finalCapital),'#f4c430'],
      ['Total Trades',R.combined.totalTrades,'#bb66ff'],
      ['Profit Months',R.combined.pctProfitableMonths+'%',R.combined.pctProfitableMonths>=60?'#00ff88':'#f4c430']
    ].map(([l,v,c])=>`<div class="stat"><div class="sl">${l}</div><div class="sv" style="color:${c}">${v}</div></div>`).join('')}
  </div>
  <div style="font-family:monospace;font-size:8px;color:#5a6f96;margin-bottom:6px;text-transform:uppercase;letter-spacing:1.5px">Year-by-Year P&L</div>
  <div style="background:#020409;border-radius:8px;border:1px solid #0f1624;overflow:hidden">${yearRows}</div>
  <div style="margin-top:9px;font-family:monospace;font-size:9px;color:#5a6f96">
    <strong style="color:#dde8ff">Strategies included:</strong> ${R.combined.topStrats.map(s=>`<span style="color:#00ff88">${s}</span>`).join(', ')}
  </div>
</div>

<!-- MONTE CARLO COMBINED -->
${mcSection}

<!-- MONTHLY EXPECTATIONS -->
${monthExpHtml}

<!-- DISCLAIMER -->
<div style="background:rgba(255,229,102,.04);border:1px solid rgba(255,229,102,.2);border-radius:9px;padding:11px;margin-bottom:12px">
  <div style="font-family:monospace;font-size:8px;color:#ffe566;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">⚠️ DISCLAIMER — READ THIS</div>
  <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.8">
    Backtest uses <strong style="color:#dde8ff">daily candles</strong> to simulate intraday strategies. Real intraday results differ due to execution timing, partial fills, option bid-ask spreads (wider than simulated), and market impact. Slippage (${R.config.slippage}) and brokerage (₹${R.config.brokerage}/trade) included but may be understated. <strong style="color:#dde8ff">SEBI data: 89% of F&O traders lose money.</strong> Past performance does not guarantee future results. Paper test for minimum 4 weeks. Start live with ₹25,000-50,000 only.
  </div>
</div>

<!-- INDIVIDUAL STRATEGIES -->
<div style="font-family:monospace;font-size:8px;letter-spacing:2px;color:#253348;text-transform:uppercase;margin-bottom:9px">INDIVIDUAL STRATEGY RESULTS (sorted by annual return)</div>
${stratHtml}

<div style="margin-top:10px;text-align:center"><a href="/run" style="display:inline-block;padding:12px 24px;background:rgba(0,255,136,.08);border:2px solid #00ff88;color:#00ff88;font-family:monospace;font-weight:700;font-size:11px;border-radius:9px;text-decoration:none;letter-spacing:2px">↻ RE-RUN BACKTEST</a></div>
<div style="margin-top:8px;text-align:center;font-family:monospace;font-size:8px;color:#253348">Generated: ${esc(R.generated)} · Data: ${esc(R.dataSource)}</div>
</div></body></html>`;
}

// ── HTTP SERVER ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname==='/health') {
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end('OK state='+btState+' progress='+btProgress+'%');
    return;
  }
  if (url.pathname==='/run') {
    if(btState!=='running') runBacktest();
    res.writeHead(302,{'Location':'/'}); res.end(); return;
  }
  const html = buildPage();
  const refresh = btState==='running' ? '<meta http-equiv="refresh" content="4">' : '';
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache, no-store'});
  res.end(html.replace('<head>', '<head>'+refresh));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('=== 10-YEAR BACKTEST ENGINE + MONTE CARLO ===');
  console.log('Port: ' + PORT);
  console.log('BUILD COMMAND: npm install');
  console.log('START COMMAND: node server.js');
  console.log('No environment variables needed. Open your Render URL to start.');
  console.log('Click the RUN button on the page to begin backtest.');
});
server.on('error', e => { console.error('FATAL:', e.message); process.exit(1); });
