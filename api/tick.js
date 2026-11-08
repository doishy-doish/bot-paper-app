// Daily paper tick. Called by Vercel Cron (and manual runs) as GET /api/tick?secret=...
// Env: TICK_SECRET, GH_TOKEN, GH_REPO ("owner/name").
// Strategy mirror of src/bot/backtest.py: SMA50/200, long-only, 0.3% friction/round-trip.
const SYMBOLS = ["RELIANCE.NS","TCS.NS","HDFCBANK.NS","ICICIBANK.NS","INFY.NS","ITC.NS","SBIN.NS","LT.NS","TITAN.NS","SUNPHARMA.NS"];
const SLOT = 10000, START_CASH = 100000, FRICTION = 0.003;
const UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"};

async function closes(sym) {
  for (const h of ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]) {
    try {
      const r = await fetch(`${h}/v8/finance/chart/${sym}?interval=1d&range=1y`, {headers: UA});
      if (!r.ok) continue;
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      const ts = res && res.timestamp || [];
      if (!q || !q.close) continue;
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close[i] == null) continue;
        out.push({date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: q.close[i]});
      }
      if (out.length > 220) return out;
    } catch (e) { /* try next host */ }
  }
  return null;
}

function signal(hist) {
  const c = hist.map(h => h.close);
  if (c.length < 201) return 0;
  const sma = (n) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
  return sma(50) > sma(200) ? 1 : 0;
}

async function gh(path, method, body) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GH_REPO}${path}`, {
    method, headers: {"Authorization": "Bearer " + process.env.GH_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "paper-tick", ...(body ? {"Content-Type": "application/json"} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  return r.json();
}

module.exports = async function handler(req, res) {
  // No auth: the paper record is public by design, and the tick is
  // idempotent (one entry per day — extra hits are no-ops).
  try {
    // load state (first run bootstraps)
    let state = {cash: START_CASH, positions: {}, trades: [], equity: []}, sha = null;
    const cur = await gh("/contents/data/paper.json", "GET");
    if (cur && cur.sha) { sha = cur.sha; state = JSON.parse(Buffer.from(cur.content, "base64").toString()); }
    const today = new Date().toISOString().slice(0, 10);
    if (state.equity.length && state.equity[state.equity.length - 1].date === today)
      return res.status(200).json({ok: true, skipped: "already ticked today"});
    const actions = [];
    for (const sym of SYMBOLS) {
      const hist = await closes(sym);
      if (!hist) { actions.push(sym + ": no data"); continue; }
      const px = hist[hist.length - 1].close, sig = signal(hist), held = !!state.positions[sym];
      if (sig === 1 && !held && state.cash >= SLOT) {
        state.positions[sym] = {entryPx: px, entryDate: hist[hist.length - 1].date, qty: SLOT / px};
        state.cash -= SLOT; actions.push(sym + ": ENTER @" + px.toFixed(1));
      } else if (sig === 0 && held) {
        const p = state.positions[sym], proceeds = p.qty * px * (1 - FRICTION);
        const invested = SLOT;
        state.cash += proceeds;
        state.trades.push({symbol: sym, entryDate: p.entryDate, exitDate: hist[hist.length - 1].date, exitPx: px, gross: proceeds / invested - 1 + FRICTION * 0, net: proceeds / invested - 1});
        delete state.positions[sym]; actions.push(sym + ": EXIT @" + px.toFixed(1));
      }
    }
    // mark to market
    let mtm = 0;
    for (const sym of Object.keys(state.positions)) {
      const hist = await closes(sym);
      if (hist) mtm += state.positions[sym].qty * hist[hist.length - 1].close;
    }
    state.equity.push({date: today, equity: Math.round((state.cash + mtm) * 100) / 100});
    const content = Buffer.from(JSON.stringify(state, null, 1)).toString("base64");
    const put = await gh("/contents/data/paper.json", "PUT",
      Object.assign({message: "tick " + today, content}, sha ? {sha} : {}));
    if (!put.content) return res.status(500).json({ok: false, err: (put.message || "commit failed").slice(0, 120)});
    return res.status(200).json({ok: true, date: today, equity: state.equity[state.equity.length - 1].equity, actions});
  } catch (e) {
    return res.status(500).json({ok: false, err: String(e).slice(0, 200)});
  }
}
