// PAPER TRADING BOT — No API Key Needed
// Uses Yahoo Finance for real Nifty prices
// PAPER_MODE always true — zero risk, zero credentials

const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 10000;
const CAPITAL = parseFloat(process.env.CAPITAL || '100000');

let capital = CAPITAL, startCap = CAPITAL;
let positions = [], closed = [], feed = [], logs = [];
let niftyLTP = 22500, niftyPrev = 22500, vix = 15;
let cycleCount = 0, botMode = 'AUTO', marketOpen = false;
let lastFetch = '—', startTime = Date.now();
let dailyPnL = 0, dailyStop = false;

function tlog(t,m){const l='['+new Date().toISOString().slice(11,19)+']['+t+'] '+m;console.log(l);logs.push(l);if(logs.length>150)logs.shift();}
function addFeed(ic,lb,msg,amt,side){feed.push({t:new Date().toISOString().slice(11,19),ic,lb,msg,amt:amt||'',side});if(feed.length>60)feed.shift();}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Fetch real Nifty price from Yahoo Finance — free, no key
async function fetchNiftyYahoo() {
  return new Promise((resolve) => {
    const now = Math.floor(Date.now()/1000);
    const from = now - 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?period1=${from}&period2=${now}&interval=1m&events=history`;
    const req = https.get(url, {
      headers: {'User-Agent':'Mozilla/5.0','Accept':'application/json'},
      timeout: 6000
    }, r => {
      let d = '';
      r.on('data', x => d += x);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const result = j?.chart?.result?.[0];
          const closes = result?.indicators?.quote?.[0]?.close;
          if (closes?.length) {
            const validClose = closes.filter(Boolean);
            if (validClose.length) {
              niftyPrev = niftyLTP;
              niftyLTP = Math.round(validClose[validClose.length-1]);
              lastFetch = new Date().toISOString().slice(11,16)+' IST';
              tlog('INFO','Yahoo: Nifty='+niftyLTP);
            }
          }
        } catch(e) { tlog('WARN','Yahoo parse: '+e.message); }
        resolve();
      });
    });
    req.on('error', () => { tlog('WARN','Yahoo fetch failed — using sim'); resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

function simNifty() {
  niftyPrev = niftyLTP;
  niftyLTP = Math.round(Math.max(18000, niftyLTP*(1+(Math.random()-0.49)*0.004)));
  lastFetch = 'SIM ' + new Date().toISOString().slice(11,16);
}

function checkSession() {
  const ist = new Date(Date.now()+19800000);
  const d = ist.getUTCDay(), h = ist.getUTCHours(), m = ist.getUTCMinutes(), t = h*60+m;
  const was = marketOpen;
  marketOpen = d>=1 && d<=5 && t>=555 && t<=930;
  if (!was && marketOpen) { dailyPnL=0; dailyStop=false; addFeed('🔔','MARKET OPEN','NSE opened. Paper trading active. Using Yahoo Finance live prices.',null,'info'); tlog('INFO','Market OPEN'); }
  if (was && !marketOpen) { squareAll(); addFeed('🔕','MARKET CLOSED','All paper positions closed at 3:30 PM.',null,'info'); tlog('INFO','Market CLOSED'); }
}

function getSignal() {
  const change = (niftyLTP - niftyPrev) / niftyPrev * 100;
  if (Math.abs(change) < 0.15) return null;
  const rsi = 50 + change * 8;
  if (change > 0.3 && rsi > 57) return { dir:'UP', opt:'CE', strat:'Momentum', conf:72, reason:'Nifty +'+change.toFixed(2)+'% move. RSI:'+rsi.toFixed(0)+'. Buying CE.' };
  if (change < -0.3 && rsi < 43) return { dir:'DOWN', opt:'PE', strat:'Momentum', conf:70, reason:'Nifty '+change.toFixed(2)+'% move. RSI:'+rsi.toFixed(0)+'. Buying PE.' };
  return null;
}

async function runCycle() {
  cycleCount++;
  checkSession();
  try { await fetchNiftyYahoo(); } catch(e) { simNifty(); }

  // Update positions
  for (let i = positions.length-1; i >= 0; i--) {
    const p = positions[i];
    const noise = (Math.random()-0.50)*0.05;
    p.cur = Math.max(1, p.cur*(1+noise));
    if (p.cur > p.peak) p.peak = p.cur;
    const pnl = (p.cur-p.entry)*p.qty;
    const hm = (Date.now()-p.openTime)/60000;
    let er = null, et = null;
    if (p.cur <= p.sl) { er='SL hit ₹'+p.cur.toFixed(0); et='SL'; }
    else if (p.cur >= p.tp) { er='Target hit ₹'+p.cur.toFixed(0); et='TP'; }
    else if (!marketOpen) { er='EOD close'; et='EOD'; }
    else if (hm > 90) { er='Time stop 90min'; et='TIME'; }
    if (er) {
      capital += p.spent + pnl; dailyPnL += pnl;
      closed.push({...p,win:pnl>0,pnl,reason:er,type:et,exit:p.cur,held:Math.round(hm),time:new Date().toISOString().slice(11,19)});
      positions.splice(i,1);
      const ic={SL:'🛑',TP:'💰',EOD:'🔕',TIME:'⏱'};
      addFeed(ic[et]||'🔴','PAPER '+et+' '+p.strat,p.sym+' — '+er,(pnl>=0?'+':'')+'₹'+Math.abs(pnl).toFixed(0),pnl>0?'win':'loss');
    }
  }

  // Enter new position
  if (marketOpen && !dailyStop && positions.length < 3 && botMode === 'AUTO') {
    if (dailyPnL < -(CAPITAL*0.03)) { dailyStop=true; addFeed('🛡','DAILY STOP','3% daily loss limit hit.',null,'guard'); }
    else {
      const sig = getSignal();
      if (sig) {
        const prem = Math.max(30, vix*13);
        const qty = Math.max(25, Math.floor(CAPITAL*0.01/prem)*25);
        capital -= prem*qty;
        const id = Date.now();
        positions.push({id,sym:'NIFTY_'+sig.opt,opt:sig.opt,dir:sig.dir,strat:sig.strat,entry:prem,cur:prem,peak:prem,sl:prem*0.40,tp:prem*1.70,qty,spent:prem*qty,reason:sig.reason,openTime:id,partialDone:false});
        tlog('TRADE','PAPER BUY NIFTY '+sig.opt+' ₹'+prem+' qty:'+qty+' ['+sig.strat+']');
        addFeed(sig.dir==='UP'?'📈':'📉','📋 PAPER '+sig.strat+' '+sig.opt,'NIFTY '+sig.opt+' | '+sig.reason,'₹'+(prem*qty).toFixed(0),'entry');
      }
    }
  }

  const pnl = positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  tlog('INFO','#'+cycleCount+' ['+botMode+'] Nifty:'+niftyLTP+' Open:'+positions.length+' Closed:'+closed.length+' PnL:₹'+pnl.toFixed(0));
}

function squareAll(){for(let i=positions.length-1;i>=0;i--){const p=positions[i];const pnl=(p.cur-p.entry)*p.qty;capital+=p.spent+pnl;dailyPnL+=pnl;closed.push({...p,win:pnl>0,pnl,reason:'EOD',type:'EOD',exit:p.cur,held:Math.round((Date.now()-p.openTime)/60000),time:new Date().toISOString().slice(11,19)});positions.splice(i,1);}}

function buildPage() {
  const pnl=positions.reduce((s,p)=>s+(p.cur-p.entry)*p.qty,0)+closed.reduce((s,t)=>s+t.pnl,0);
  const wins=closed.filter(t=>t.win).length,tot=closed.length,losses=tot-wins,wr=tot?Math.round(wins/tot*100):0;
  const up=Math.round((Date.now()-startTime)/60000);
  const mc=botMode==='AUTO'?'#00ff88':botMode==='MANUAL'?'#f4c430':'#ff3355';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>Paper Trader — No Key</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{background:#020409;color:#dde8ff;font-family:'Outfit',sans-serif;min-height:100vh;font-size:14px}.tabs{display:flex;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto}.tabs::-webkit-scrollbar{display:none}.tab{padding:9px 12px;font-weight:700;font-size:10px;border-bottom:3px solid transparent;color:#253348;white-space:nowrap;flex-shrink:0;text-decoration:none;display:block}.pg{display:none;padding:11px}.pg.act{display:block}@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}.ld{width:5px;height:5px;border-radius:50%;background:#00ff88;box-shadow:0 0 5px #00ff88;animation:bl 1.8s infinite;display:inline-block;vertical-align:middle}.mbtn{display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:7px;font-family:monospace;font-size:9px;font-weight:700;text-decoration:none;border:1px solid;cursor:pointer}</style>
</head><body>
<div style="position:sticky;top:0;z-index:100;background:rgba(2,4,9,.97);border-bottom:1px solid #0f1624;padding:8px 12px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-family:'Bebas Neue',cursive;font-size:13px;letter-spacing:2px;background:linear-gradient(90deg,#00ff88,#f4c430);-webkit-background-clip:text;-webkit-text-fill-color:transparent">PAPER TRADER</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 5px;border-radius:5px;border:1px solid rgba(0,229,255,.3);color:#00e5ff">📋 PAPER</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 5px;border-radius:5px;border:1px solid ${marketOpen?'rgba(0,255,136,.3)':'#253348'};color:${marketOpen?'#00ff88':'#253348'}">${marketOpen?'OPEN':'CLOSED'}</span>
      <span style="font-family:monospace;font-size:7px;padding:2px 5px;border-radius:5px;border:1px solid #253348;color:#5a6f96">YAHOO FINANCE DATA</span>
    </div>
    <div style="text-align:right"><div style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:#f4c430">₹${capital.toFixed(0)}</div><div style="font-family:monospace;font-size:7px;color:#253348">#${cycleCount}</div></div>
  </div>
  <div style="display:flex;align-items:center;gap:6px">
    <span style="font-family:monospace;font-size:8px;color:#253348">MODE:</span>
    <a href="/set?mode=AUTO" class="mbtn" style="color:#00ff88;border-color:rgba(0,255,136,.35);background:${botMode==='AUTO'?'rgba(0,255,136,.2)':'rgba(0,255,136,.06)'}">🤖 AUTO</a>
    <a href="/set?mode=MANUAL" class="mbtn" style="color:#f4c430;border-color:rgba(244,196,48,.35);background:${botMode==='MANUAL'?'rgba(244,196,48,.2)':'rgba(244,196,48,.06)'}">🎮 MANUAL</a>
    <a href="/set?mode=OFF" class="mbtn" style="color:#ff3355;border-color:rgba(255,51,85,.35);background:${botMode==='OFF'?'rgba(255,51,85,.2)':'rgba(255,51,85,.06)'}">🛑 OFF</a>
    <span style="margin-left:auto;font-family:monospace;font-size:7px;color:#5a6f96">Last: ${esc(lastFetch)}</span>
  </div>
</div>

<div style="display:flex;align-items:center;padding:5px 12px;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto">
  ${[['NIFTY',niftyLTP,'#dde8ff'],['CHANGE',((niftyLTP-niftyPrev)/niftyPrev*100).toFixed(2)+'%',(niftyLTP>=niftyPrev?'#00ff88':'#ff3355')],['VIX',vix.toFixed(1),vix>25?'#ff3355':vix>18?'#f4c430':'#00ff88'],['Daily P&L',(dailyPnL>=0?'+':'')+'₹'+dailyPnL.toFixed(0),dailyPnL>=0?'#00ff88':'#ff3355']].map(([n,v,c])=>`<div style="padding:4px 10px;border-right:1px solid #0f1624;white-space:nowrap"><div style="font-family:monospace;font-size:7px;color:#253348">${n}</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${c}">${v}</div></div>`).join('')}
  <div style="margin-left:auto;padding:4px 8px;flex-shrink:0;display:flex;align-items:center;gap:3px"><span class="ld"></span><span style="font-family:monospace;font-size:7px;color:#00ff88">LIVE</span></div>
</div>

<div style="display:grid;grid-template-columns:repeat(4,1fr);background:#06080e;border-bottom:1px solid #0f1624">
  <div style="padding:6px 7px;border-right:1px solid #0f1624"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">P&L</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${pnl>=0?'#00ff88':'#ff3355'}">${(pnl>=0?'+':'')+'₹'+pnl.toFixed(0)}</div></div>
  <div style="padding:6px 7px;border-right:1px solid #0f1624"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">Win%</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#f4c430">${tot?wr+'%':'—'}</div></div>
  <div style="padding:6px 7px;border-right:1px solid #0f1624"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">Trades</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#bb66ff">${tot}</div></div>
  <div style="padding:6px 7px"><div style="font-family:monospace;font-size:7px;color:#253348;text-transform:uppercase;margin-bottom:1px">Open</div><div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#00e5ff">${positions.length}</div></div>
</div>

<div style="display:flex;background:#06080e;border-bottom:1px solid #0f1624;overflow-x:auto">
  ${['feed','pos','hist','log'].map(t=>`<a href="/?tab=${t}" style="padding:9px 12px;font-weight:700;font-size:10px;color:${(new URL('http://x'+'/').searchParams?.get('tab')||'feed')===t?'#00ff88':'#253348'};border-bottom:3px solid transparent;text-decoration:none;white-space:nowrap">${{feed:'📡 Feed',pos:'📊 Pos',hist:'📈 Hist',log:'🖥 Log'}[t]}</a>`).join('')}
</div>

<div style="padding:11px">
  <div style="background:#090b15;border:1px solid rgba(0,229,255,.2);border-radius:9px;padding:11px;margin-bottom:11px">
    <div style="font-family:monospace;font-size:8px;color:#00e5ff;letter-spacing:2px;margin-bottom:6px">✓ NO API KEY NEEDED — ZERO CREDENTIALS</div>
    <div style="font-family:monospace;font-size:9px;color:#5a6f96;line-height:1.7">Live Nifty prices from <strong style="color:#dde8ff">Yahoo Finance</strong> (free, no login). Paper trading only — no real orders ever. Safe for testing without any broker account.</div>
  </div>

  ${feed.length===0?'<p style="font-family:monospace;font-size:11px;color:#253348;padding:14px;text-align:center">'+(marketOpen?'Scanning...':'Market closed.')+'</p>'
    :[...feed].reverse().slice(0,20).map(f=>{const col=f.side==='entry'?'#00ff88':f.side==='win'?'#00ff88':f.side==='loss'?'#ff3355':'#5a6f96';return`<div style="display:flex;gap:8px;padding:9px 12px;border-bottom:1px solid #0f1624;border-left:3px solid ${col}"><div style="font-size:14px;width:20px;flex-shrink:0">${esc(f.ic)}</div><div style="flex:1;min-width:0"><div style="font-family:monospace;font-size:8px;color:#bb66ff;margin-bottom:1px;font-weight:700">${esc(f.lb)}</div><div style="font-family:monospace;font-size:10px;color:#5a6f96">${esc(f.msg)}</div></div><div style="text-align:right;flex-shrink:0">${f.amt?`<div style="font-family:monospace;font-size:11px;font-weight:700;color:${col}">${esc(f.amt)}</div>`:''}<div style="font-family:monospace;font-size:7px;color:#253348;margin-top:2px">${esc(f.t)}</div></div></div>`;}).join('')}
</div>

<script>setTimeout(function(){window.location.reload();},30000);</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('OK paper nifty='+niftyLTP+' cycle='+cycleCount);return;}
  if (url.pathname==='/set'){const p=url.searchParams;if(p.has('mode')&&['AUTO','MANUAL','OFF'].includes(p.get('mode')))botMode=p.get('mode');res.writeHead(302,{'Location':'/'});res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
  res.end(buildPage());
});

server.listen(PORT,'0.0.0.0',()=>{
  tlog('INFO','Paper Trader started — uses Yahoo Finance, no API key needed');
  setInterval(runCycle, 30000);
  runCycle();
});
server.on('error',e=>{console.error('FATAL:',e.message);process.exit(1);});
