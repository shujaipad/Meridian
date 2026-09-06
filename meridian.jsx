import React, { useState, useEffect, useMemo, useCallback } from "react";
import Papa from "papaparse";
import { Upload, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus, Search, RotateCcw, Star, Plus, X, ListPlus, Filter, Bell } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

// The computation engine lives in its own module so the production compute job
// (§6.2) imports the same code this UI runs, rather than a copy that can drift.
import {
  avg,
  closesByKeyFromPrices,
  computeAll,
  computeBreadthSeries,
  computeFundamentalScores,
  computeRSUniverse,
  computeSectoralSeries,
  computeTechnicalBlock,
  runGoldenBreakoutScreener,
} from "./meridian-engine.js";

// ---------- Design tokens ----------
// Deep indigo ledger aesthetic, gold accent, green/red reserved strictly for gain/loss semantics.
const T = {
  bg: "#14192B",
  surface: "#1B2140",
  surfaceAlt: "#232A4D",
  border: "#323A63",
  text: "#EDEAE0",
  textDim: "#9AA2C0",
  gold: "#C9A227",
  gain: "#4CAF7D",
  loss: "#D46A6A",
  amber: "#E0983E",
  neutral: "#8890A6",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;

// ---------- Sample / demo data (clearly synthetic, for pilot only) ----------
const SAMPLE_MASTER = [
  { ISIN: "INE002A01018", Symbol: "RELIANCE", Name: "Reliance Industries", Sector: "Energy", IndustryGroup: "Oil & Gas", MarketCap: 1750000, PE: 24.1 },
  { ISIN: "INE467B01029", Symbol: "TCS", Name: "Tata Consultancy Services", Sector: "IT", IndustryGroup: "Information Technology", MarketCap: 1420000, PE: 27.8 },
  { ISIN: "INE040A01034", Symbol: "HDFCBANK", Name: "HDFC Bank", Sector: "Financials", IndustryGroup: "Banking and Finance", MarketCap: 1280000, PE: 18.4 },
  { ISIN: "INE154A01025", Symbol: "ITC", Name: "ITC Ltd", Sector: "FMCG", IndustryGroup: "Fast Moving Consumer Goods", MarketCap: 540000, PE: 22.9 },
  { ISIN: "INE075A01022", Symbol: "WIPRO", Name: "Wipro Ltd", Sector: "IT", IndustryGroup: "Information Technology", MarketCap: 260000, PE: 20.3 },
  { ISIN: "INE752E01010", Symbol: "POWERGRID", Name: "Power Grid Corp", Sector: "Utilities", IndustryGroup: "Power", MarketCap: 300000, PE: 15.2 },
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function genSamplePrices(isin, basePrice, days = 400) {
  const rand = seededRandom(isin.split("").reduce((a, c) => a + c.charCodeAt(0), 0));
  const rows = [];
  let price = basePrice;
  const start = new Date();
  start.setDate(start.getDate() - days);
  for (let i = 0; i < days; i++) {
    const drift = (rand() - 0.47) * 0.018;
    price = Math.max(price * (1 + drift), 1);
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    rows.push({
      ISIN: isin,
      Date: d.toISOString().slice(0, 10),
      Close: Number(price.toFixed(2)),
      Volume: Math.round(500000 + rand() * 2000000),
    });
  }
  return rows;
}

function genSampleFundamentals(isin, seed) {
  const rand = seededRandom(seed);
  const years = ["FY23", "FY24", "FY25", "FY26"];
  let equity = 100000, sales = 200000, eps = 40;
  return years.map((fy, i) => {
    equity *= 1 + 0.08 + rand() * 0.05;
    sales *= 1 + 0.06 + rand() * 0.08;
    eps *= 1 + 0.05 + rand() * 0.1;
    const netProfit = equity * (0.12 + rand() * 0.08);
    const capEmployed = equity * (1.3 + rand() * 0.2);
    const ebit = capEmployed * (0.14 + rand() * 0.06);
    const debt = equity * (0.2 + rand() * 0.4);
    const fixedAssets = sales / (0.9 + rand() * 0.6);
    const cwip = fixedAssets * (0.02 + rand() * 0.08);
    return {
      ISIN: isin, FY: fy,
      ROE_Pct: Number(((netProfit / equity) * 100).toFixed(2)),
      ROCE_Pct: Number(((ebit / capEmployed) * 100).toFixed(2)),
      DebtEquity: Number((debt / equity).toFixed(3)),
      EPS: Number(eps.toFixed(2)), Sales: Math.round(sales),
      FixedAssets: Math.round(fixedAssets), CWIP: Math.round(cwip),
    };
  });
}

const SAMPLE_PRICES = SAMPLE_MASTER.flatMap((m) => genSamplePrices(m.ISIN, m.PE * 100));
const SAMPLE_FUND = SAMPLE_MASTER.flatMap((m, idx) => genSampleFundamentals(m.ISIN, idx + 7));

// ---------- Commodities: sample data (synthetic) ----------
const SAMPLE_COMMODITIES = [
  { Symbol: "GOLD", Name: "Gold", Unit: "₹/10g" },
  { Symbol: "SILVER", Name: "Silver", Unit: "₹/kg" },
  { Symbol: "CRUDEOIL", Name: "Crude Oil", Unit: "₹/bbl" },
  { Symbol: "NATURALGAS", Name: "Natural Gas", Unit: "₹/mmBtu" },
];
const COMMODITY_BASE_PRICES = { GOLD: 62000, SILVER: 78000, CRUDEOIL: 6200, NATURALGAS: 250 };
// Reuses genSamplePrices — its "ISIN" field is repurposed to hold the commodity Symbol.
const SAMPLE_COMMODITY_PRICES = SAMPLE_COMMODITIES.flatMap((c) => genSamplePrices(c.Symbol, COMMODITY_BASE_PRICES[c.Symbol]));

// ---------- Asset class configuration (drives the generic screens) ----------
const ASSET_CLASSES = {
  commodities: {
    key: "commodities", label: "Commodities", labelSingular: "commodity", accent: "#C87941",
    storagePrefix: "screener-commodities", extraMasterFields: ["Unit"],
    sampleMaster: SAMPLE_COMMODITIES, samplePrices: SAMPLE_COMMODITY_PRICES,
  },
  indices: {
    key: "indices", label: "Global Indices", labelSingular: "index", accent: "#5B8DEF",
    storagePrefix: "screener-indices", extraMasterFields: ["Region"],
    sampleMaster: [], samplePrices: [],
  },
  crypto: {
    key: "crypto", label: "Crypto", labelSingular: "coin", accent: "#A46EF5",
    storagePrefix: "screener-crypto", extraMasterFields: [],
    sampleMaster: [], samplePrices: [],
  },
  currencies: {
    key: "currencies", label: "Currencies", labelSingular: "currency", accent: "#2DB9A3",
    storagePrefix: "screener-currencies", extraMasterFields: [],
    sampleMaster: [], samplePrices: [],
  },
};




// ---------- Chunked persistent storage ----------
// window.storage caps each key at 5MB. A full price-history load (hundreds of
// thousands of rows) is tens of MB as JSON, so it silently failed to save under
// a single key — this is why data wasn't surviving between sessions. Splitting
// it across many keys, each safely under the cap, fixes that.
const STORAGE_CHUNK_SIZE = 40000; // rows per chunk — keeps each chunk well under 5MB

async function saveChunkedArray(baseKey, arr) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += STORAGE_CHUNK_SIZE) chunks.push(arr.slice(i, i + STORAGE_CHUNK_SIZE));
  for (let i = 0; i < chunks.length; i++) {
    await window.storage.set(`${baseKey}-chunk-${i}`, JSON.stringify(chunks[i]), false);
  }
  // clean up any stale chunks left over from a previous, larger save
  let i = chunks.length;
  while (true) {
    try {
      const existing = await window.storage.get(`${baseKey}-chunk-${i}`, false);
      if (!existing) break;
      await window.storage.delete(`${baseKey}-chunk-${i}`, false);
      i++;
    } catch (e) { break; }
  }
  await window.storage.set(`${baseKey}-meta`, JSON.stringify({ count: chunks.length, totalRows: arr.length }), false);
}

// Lightweight save check: reads only the small meta key and compares the row COUNT it
// recorded at save time — never reloads and re-parses the actual chunked data, which for
// a large dataset would mean holding two full copies in memory simultaneously (this is
// exactly what caused real upload crashes on the full price history).
async function verifyChunkedArraySaved(baseKey, expectedRows) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (!metaRes || !metaRes.value) return expectedRows === 0;
    const { totalRows } = JSON.parse(metaRes.value);
    return totalRows === expectedRows;
  } catch (e) { return false; }
}

async function loadChunkedArray(baseKey) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (!metaRes || !metaRes.value) return [];
    const { count } = JSON.parse(metaRes.value);
    let out = [];
    for (let i = 0; i < count; i++) {
      try {
        const res = await window.storage.get(`${baseKey}-chunk-${i}`, false);
        if (res && res.value) out = out.concat(JSON.parse(res.value));
      } catch (e) { console.error(`Missing storage chunk ${i} for ${baseKey}`); }
    }
    return out;
  } catch (e) { return []; }
}

async function deleteChunkedArray(baseKey) {
  try {
    const metaRes = await window.storage.get(`${baseKey}-meta`, false);
    if (metaRes && metaRes.value) {
      const { count } = JSON.parse(metaRes.value);
      for (let i = 0; i < count; i++) {
        try { await window.storage.delete(`${baseKey}-chunk-${i}`, false); } catch (e) {}
      }
    }
    await window.storage.delete(`${baseKey}-meta`, false);
  } catch (e) { /* nothing to delete */ }
}


// ---------- UI helpers ----------
function fmtCr(v) {
  if (v == null) return "—";
  return `₹${Math.round(v).toLocaleString("en-IN")} Cr`;
}
function fmtNum(v, d = 1) { return v == null || isNaN(v) ? "—" : v.toFixed(d); }
function fmtPct(v, d = 1) { return v == null || isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`; }

// Item labels are asset-class config, not literals, so a bare +"s" mispluralizes
// four of the six in use — industry, commodity, currency, index. "indices" over
// "indexes" to match the Global Indices tab.
function pluralizeLower(word) {
  const w = word.toLowerCase();
  if (w === "index") return "indices";
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

function FlagBadge({ flag }) {
  if (!flag) return <span style={{ color: T.textDim }}>—</span>;
  const map = {
    improvement: { color: T.gain, icon: <TrendingUp size={12} />, label: "Improving" },
    deterioration: { color: T.loss, icon: <TrendingDown size={12} />, label: "Deteriorating" },
    neutral: { color: T.neutral, icon: <Minus size={12} />, label: "Neutral" },
  };
  const cfg = map[flag];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: cfg.color, fontSize: 11, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function RSRatingBadge({ rsRating }) {
  if (!rsRating || rsRating.rating == null) return <span style={{ color: T.textDim }}>—</span>;
  const colorMap = { red: T.loss, amber: T.amber, green: T.gain };
  const color = colorMap[rsRating.band];
  const streakLabel = rsRating.capped ? `${rsRating.streakDays}+d` : `${rsRating.streakDays}d`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 12, padding: "2px 7px", borderRadius: 4,
        color, background: `${color}22`, border: `1px solid ${color}`,
      }}>{rsRating.rating}</span>
      <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{streakLabel}</span>
    </span>
  );
}

const FUND_TIER_COLORS = { High: "#4CAF7D", Good: "#8FC97D", Average: "#9AA2C0", Weak: "#E0983E", Poor: "#D46A6A" };

function FundTierBadge({ fundScore }) {
  if (!fundScore || fundScore.score == null) return <span style={{ color: T.textDim }}>—</span>;
  const color = FUND_TIER_COLORS[fundScore.tier] || T.textDim;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700, fontSize: 11, padding: "2px 7px", borderRadius: 4,
        color, background: `${color}22`, border: `1px solid ${color}`,
      }}>{fundScore.tier}</span>
      <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{fundScore.score.toFixed(1)}{fundScore.exempt ? "*" : ""}</span>
    </span>
  );
}

function SignalPill({ active, label, streak, capped }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "baseline", gap: 3, minWidth: 26, textAlign: "center", padding: "2px 5px", borderRadius: 3,
      fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
      background: active == null ? "transparent" : active ? "rgba(76,175,125,0.15)" : "rgba(212,106,106,0.12)",
      color: active == null ? T.textDim : active ? T.gain : T.loss,
      border: `1px solid ${active == null ? T.border : active ? T.gain : T.loss}`,
    }}>
      {label}
      {streak != null && <span style={{ fontSize: 8.5, opacity: 0.85 }}>{capped ? `${streak}+` : streak}</span>}
    </span>
  );
}

function FundRow({ label, block, isPercent = true }) {
  if (!block) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 70px 70px 70px 1fr", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontSize: 12, color: T.textDim }}>{label}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{fmtNum(block.avg3)}{isPercent ? "%" : "x"}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600 }}>{fmtNum(block.lastYr)}{isPercent ? "%" : "x"}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: T.textDim }}>{fmtPct(block.variationPct)}</span>
      <FlagBadge flag={block.flag} />
    </div>
  );
}

// ---------- Column filtering (numeric range filters, Excel-style) ----------
// Stock name and CMP are intentionally excluded — filtering by exact price/name
// isn't useful; everything else that's a single scalar value gets a range filter.
const FILTERABLE_COLUMNS = {
  changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
  MarketCap: { label: "Mkt Cap", accessor: (s) => s.MarketCap },
  PE: { label: "P/E", accessor: (s) => s.PE },
  ROE: { label: "ROE (LY)", accessor: (s) => s.fund?.roe?.lastYr },
  fundTier: { label: "Fund Score", accessor: (s) => s.fund?.score?.score },
  RSI: { label: "RSI", accessor: (s) => s.tech?.rsi },
  relStrength: { label: "RS Rating", accessor: (s) => s.tech?.rsRating?.rating },
  pctFromHigh52: { label: "% fr 52wH", accessor: (s) => s.tech?.pctFromHigh52 },
  pctFromLow52: { label: "% fr 52wL", accessor: (s) => s.tech?.pctFromLow52 },
  volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
};

function NumFilterPopover({ colKey, label, current, onApply, onClear, onClose }) {
  const [min, setMin] = useState(current?.min ?? "");
  const [max, setMax] = useState(current?.max ?? "");
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", left: 0, zIndex: 30, background: T.surfaceAlt,
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, minWidth: 150,
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)", textTransform: "none", letterSpacing: "normal", fontWeight: 400,
    }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 6 }}>Filter {label}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input type="number" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)}
          style={{ width: 62, padding: "5px 6px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
        <input type="number" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)}
          style={{ width: 62, padding: "5px 6px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => { onApply(colKey, { min: min === "" ? null : Number(min), max: max === "" ? null : Number(max) }); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Apply</button>
        <button onClick={() => { onClear(colKey); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>Clear</button>
      </div>
    </div>
  );
}

// ---------- Commodities Screen (standalone: technicals only, no fundamentals) ----------
// A lightweight sibling to GenericAssetScreen — reads the SAME persisted storage (so it
// stays in sync with whatever's loaded on the base data tab without sharing React state),
// computes technicals + RS, and runs the Golden Breakout screener against it.
function GenericGoldenBreakoutScreen({ config }) {
  const [master, setMaster] = useState([]);
  const [prices, setPrices] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const metaRes = await window.storage.get(`${config.storagePrefix}-meta`, false);
        if (metaRes && metaRes.value) setMaster(JSON.parse(metaRes.value).master || []);
        const loadedPrices = await loadChunkedArray(`${config.storagePrefix}-prices`);
        setPrices(loadedPrices);
      } catch (e) { /* no saved data yet */ }
    })();
  }, [config.storagePrefix]);

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const priceBySym = {};
    prices.forEach((r) => { (priceBySym[r.ISIN] ||= []).push(r); });
    return master.map((m) => {
      const tech = computeTechnicalBlock(priceBySym[m.Symbol] || []);
      return { ...m, ISIN: m.Symbol, fund: null, tech: tech ? { ...tech, rsRating: rsUniverse[m.Symbol] || null } : tech };
    });
  }, [master, prices, rsUniverse]);

  const candidates = useMemo(() => runGoldenBreakoutScreener(computed), [computed]);

  return <GoldenBreakoutScreen candidates={candidates} accent={config.accent} hasFundamentals={false} itemLabel={config.labelSingular.charAt(0).toUpperCase() + config.labelSingular.slice(1)} />;
}

function GenericAssetScreen({ config }) {
  const { key, label, labelSingular, accent, storagePrefix, extraMasterFields, sampleMaster, samplePrices } = config;
  const [master, setMaster] = useState([]);
  const [prices, setPrices] = useState([]);
  const [usingSample, setUsingSample] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [status, setStatus] = useState("");
  const [showManage, setShowManage] = useState(false);
  const [manageSearch, setManageSearch] = useState("");
  const [newItem, setNewItem] = useState({ Symbol: "", Name: "", ...Object.fromEntries(extraMasterFields.map((f) => [f, ""])) });
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const metaRes = await window.storage.get(`${storagePrefix}-meta`, false);
        if (metaRes && metaRes.value) {
          const parsed = JSON.parse(metaRes.value);
          setMaster(parsed.master || []);
          setUsingSample(parsed.usingSample || false);
        }
        const loadedPrices = await loadChunkedArray(`${storagePrefix}-prices`);
        setPrices(loadedPrices);
      } catch (e) { /* no saved data yet */ }
    })();
  }, [storagePrefix]);

  const persist = useCallback(async (next) => {
    try {
      await window.storage.set(`${storagePrefix}-meta`, JSON.stringify({ master: next.master, usingSample: next.usingSample }), false);
      await saveChunkedArray(`${storagePrefix}-prices`, next.prices || []);
    } catch (e) { console.error(e); }
  }, [storagePrefix]);

  const loadSample = () => {
    setMaster(sampleMaster); setPrices(samplePrices); setUsingSample(true);
    persist({ master: sampleMaster, prices: samplePrices, usingSample: true });
    setStatus(`Loaded demo ${labelSingular} data (synthetic).`);
  };

  const clearAll = async () => {
    setMaster([]); setPrices([]); setUsingSample(false);
    try { await window.storage.delete(`${storagePrefix}-meta`, false); } catch (e) {}
    await deleteChunkedArray(`${storagePrefix}-prices`);
    setStatus("Cleared.");
  };

  const upsertBySymbol = (existing, incoming) => {
    const incomingKeys = new Set(incoming.map((r) => r.ISIN));
    return [...existing.filter((r) => !incomingKeys.has(r.ISIN)), ...incoming];
  };

  const NUMERIC_FIELDS = { master: new Set(["MarketCap"]), prices: new Set(["Close", "Volume"]) };

  const handleUpload = (file, kind) => {
    const numericFields = NUMERIC_FIELDS[kind] || new Set();
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      transform: (value, field) => (numericFields.has(field) ? (value === "" ? null : Number(value)) : value),
      complete: (res) => {
        const rows = res.data;
        let nextMaster = master, nextPrices = prices;
        if (kind === "master") {
          const keyed = new Set(rows.map((r) => r.Symbol));
          nextMaster = [...master.filter((m) => !keyed.has(m.Symbol)), ...rows];
          setMaster(nextMaster);
        }
        if (kind === "prices") {
          const mapped = rows.map((r) => ({ ISIN: r.Symbol, Date: r.Date, Close: r.Close, Volume: r.Volume }));
          nextPrices = upsertBySymbol(prices, mapped);
          setPrices(nextPrices);
        }
        setUsingSample(false);
        persist({ master: nextMaster, prices: nextPrices, usingSample: false });
        setStatus(`Loaded ${rows.length} rows into ${kind} (merged by symbol).`);
      },
      error: (err) => setStatus(`Error parsing file: ${err.message}`),
    });
  };

  const addItem = () => {
    const sym = newItem.Symbol.trim();
    if (!sym) { setStatus("Symbol is required."); return; }
    if (master.some((m) => m.Symbol === sym)) { setStatus(`${sym} is already tracked.`); return; }
    const row = { Symbol: sym, Name: newItem.Name.trim() || sym };
    extraMasterFields.forEach((f) => { row[f] = (newItem[f] || "").trim(); });
    const nextMaster = [...master, row];
    setMaster(nextMaster); setUsingSample(false);
    persist({ master: nextMaster, prices, usingSample: false });
    setNewItem({ Symbol: "", Name: "", ...Object.fromEntries(extraMasterFields.map((f) => [f, ""])) });
    setStatus(`Added ${row.Name}. Upload its price history to see computed fields.`);
  };

  const removeItem = (sym, name) => {
    if (!window.confirm(`Remove ${name} (${sym})? This also clears its price history.`)) return;
    const nextMaster = master.filter((m) => m.Symbol !== sym);
    const nextPrices = prices.filter((p) => p.ISIN !== sym);
    setMaster(nextMaster); setPrices(nextPrices);
    persist({ master: nextMaster, prices: nextPrices, usingSample });
    setStatus(`Removed ${name}.`);
  };

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const priceBySym = {};
    prices.forEach((r) => { (priceBySym[r.ISIN] ||= []).push(r); });
    return master.map((m) => {
      const tech = computeTechnicalBlock(priceBySym[m.Symbol] || []);
      return { ...m, tech: tech ? { ...tech, rsRating: rsUniverse[m.Symbol] || null } : tech };
    });
  }, [master, prices, rsUniverse]);

  const FILTERABLE = {
    changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
    RSI: { label: "RSI", accessor: (s) => s.tech?.rsi },
    rsRating: { label: "RS Rating", accessor: (s) => s.tech?.rsRating?.rating },
    pctFromHigh52: { label: "% fr 52wH", accessor: (s) => s.tech?.pctFromHigh52 },
    pctFromLow52: { label: "% fr 52wL", accessor: (s) => s.tech?.pctFromLow52 },
    volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
  };
  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const [maFilters, setMaFilters] = useState({ S: null, M: null });
  const clearAllFilters = () => { setColFilters({}); setMaFilters({ S: null, M: null }); };

  const filtered = useMemo(() => {
    let list = computed.filter((s) =>
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = FILTERABLE[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      }) &&
      matchesMASignals(s.tech?.sSignals, s.tech?.sStreaks, maFilters.S, [3, 8, 30, 50, 100, 200]) &&
      matchesMASignals(s.tech?.mSignals, s.tech?.mStreaks, maFilters.M, [3, 8, 30, 100])
    );
    list.sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "RSI") return row.tech?.rsi ?? -Infinity;
        if (sortKey === "rsRating") return row.tech?.rsRating?.rating ?? -Infinity;
        if (sortKey === "pctFromHigh52") return row.tech?.pctFromHigh52 ?? -Infinity;
        if (sortKey === "pctFromLow52") return row.tech?.pctFromLow52 ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, search, sortKey, sortDir, colFilters, maFilters]);

  const toggleSort = (k) => { if (sortKey === k) setSortDir((d) => -d); else { setSortKey(k); setSortDir(1); } };
  const sortArrow = (k) => {
    if (sortKey !== k) return null;
    const up = sortDir === 1;
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${accent}` : "none",
        borderTop: up ? "none" : `6px solid ${accent}`,
      }} />
    );
  };

  const FilterableTh = ({ colKey, label: colLabel }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{colLabel}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? accent : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={colLabel} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const hasData = master.length > 0;

  return (
    <div onClick={() => setOpenFilterKey(null)}>
      <div style={{ padding: "16px 24px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[{ kind: "master", label: `${label} master` }, { kind: "prices", label: "Prices (daily EOD)" }].map(({ kind, label: btnLabel }) => (
            <label key={kind} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 12, color: T.text, background: T.surfaceAlt }}>
              <Upload size={13} color={accent} /> {btnLabel}
              <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0], kind)} />
            </label>
          ))}
          {sampleMaster.length > 0 && (
            <button onClick={loadSample} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${accent}`, background: "transparent", color: accent, fontSize: 12, fontWeight: 600 }}>Load demo data</button>
          )}
          <button onClick={() => setShowManage((v) => !v)} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: showManage ? T.surfaceAlt : "transparent", color: T.text, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ListPlus size={13} color={accent} /> Manage {label.toLowerCase()} ({master.length})
          </button>
          <button onClick={clearAll} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <RotateCcw size={12} /> Clear
          </button>
          {status && <span style={{ fontSize: 11, color: T.textDim, marginLeft: 4 }}>{status}</span>}
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 10, lineHeight: 1.5 }}>
          <b style={{ color: T.text }}>CSV columns expected —</b> {label} master: Symbol, Name{extraMasterFields.length ? `, ${extraMasterFields.join(", ")}` : ""} · Prices (one row per {labelSingular} per trading day, ~1yr+): Symbol, Date, Close, Volume. Uploads merge in by symbol. Technicals only — same signal logic as Equities; no fundamentals.
        </div>
        {showManage && (
          <div style={{ marginTop: 14, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 10 }}>Add a {labelSingular}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {["Symbol", "Name", ...extraMasterFields].map((f) => (
                <input key={f} value={newItem[f]} onChange={(e) => setNewItem({ ...newItem, [f]: e.target.value })} placeholder={f}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: f === "Name" ? 160 : 110 }} />
              ))}
              <button onClick={addItem} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${accent}`, background: `${accent}22`, color: accent, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Plus size={12} /> Add
              </button>
            </div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8, marginTop: 14 }}>Current list ({master.length})</div>
            <input value={manageSearch} onChange={(e) => setManageSearch(e.target.value)} placeholder="Filter..."
              style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {master.filter((m) => !manageSearch || (m.Name || "").toLowerCase().includes(manageSearch.toLowerCase()) || (m.Symbol || "").toLowerCase().includes(manageSearch.toLowerCase())).map((m) => (
                <div key={m.Symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${T.border}`, fontSize: 12 }}>
                  <span>{m.Name} <span style={{ color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5 }}>{m.Symbol}{extraMasterFields.map((f) => m[f] ? ` · ${m[f]}` : "").join("")}</span></span>
                  <button onClick={() => removeItem(m.Symbol, m.Name)} title="Remove" style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.loss, display: "inline-flex" }}><X size={12} /></button>
                </div>
              ))}
              {master.length === 0 && <div style={{ color: T.textDim, fontSize: 12 }}>No {label.toLowerCase()} yet.</div>}
            </div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          Upload {labelSingular} price data{sampleMaster.length > 0 ? " or load demo data" : ""} to see the screen.
        </div>
      ) : (
        <>
          <div style={{ padding: "12px 24px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${labelSingular}...`}
                style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 180 }} />
            </div>
            {(Object.keys(colFilters).length > 0 || maFilters.S || maFilters.M) && (
              <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Filter size={11} color={accent} /> {Object.keys(colFilters).length + (maFilters.S ? 1 : 0) + (maFilters.M ? 1 : 0)} filter{(Object.keys(colFilters).length + (maFilters.S ? 1 : 0) + (maFilters.M ? 1 : 0)) > 1 ? "s" : ""} active <X size={11} />
              </button>
            )}
          </div>

          <div style={{ padding: "0 24px 40px", overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
            <table>
              <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
                <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th></th>
                  <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>{labelSingular.charAt(0).toUpperCase() + labelSingular.slice(1)}{sortArrow("Name")}</th>
                  <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                  <FilterableTh colKey="changePct" label="1D %" />
                  <FilterableTh colKey="RSI" label="RSI" />
                  <FilterableTh colKey="rsRating" label="RS Rating" />
                  <FilterableTh colKey="pctFromHigh52" label="% fr 52wH" />
                  <FilterableTh colKey="pctFromLow52" label="% fr 52wL" />
                  <FilterableTh colKey="volBreakout" label="Vol Brk %" />
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    Price vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maS" ? null : "maS"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.S ? accent : T.textDim} />
                    </button>
                    {openFilterKey === "maS" && (
                      <MASignalFilterPopover title="Filter: Price vs Moving Average" periods={[3, 8, 30, 50, 100, 200]} prefix="S"
                        current={maFilters.S} onApply={(cfg) => setMaFilters((f) => ({ ...f, S: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, S: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    MA vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maM" ? null : "maM"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.M ? accent : T.textDim} />
                    </button>
                    {openFilterKey === "maM" && (
                      <MASignalFilterPopover title="Filter: MA vs MA" periods={[3, 8, 30, 100]} prefix="M"
                        current={maFilters.M} onApply={(cfg) => setMaFilters((f) => ({ ...f, M: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, M: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const isOpen = expanded === s.Symbol;
                  const t = s.tech;
                  return (
                    <React.Fragment key={s.Symbol}>
                      <tr onClick={() => setExpanded(isOpen ? null : s.Symbol)}
                        style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                        <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                        <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}{extraMasterFields.map((f) => s[f] ? ` · ${s[f]}` : "").join("")}</div></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? fmtNum(t.cmp, 2) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.rsi > 70 ? T.loss : t?.rsi < 30 ? T.gain : T.text }}>{t ? fmtNum(t.rsi) : "—"}</td>
                        <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.textDim }}>{t ? fmtPct(t.pctFromHigh52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.pctFromLow52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? accent : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                        <td>{t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                        <td>{t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => removeItem(s.Symbol, s.Name)} title="Remove" style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, display: "inline-flex" }}><X size={11} /></button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={12} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                            {t ? (
                              <div style={{ fontSize: 12, lineHeight: 2 }}>
                                <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.low52, 2)} – {fmtNum(t.high52, 2)}</b></div>
                                <div>% from 52w high / low: <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.loss }}>{fmtPct(t.pctFromHigh52, 0)}</b> <span style={{ color: T.textDim }}>/</span> <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{fmtPct(t.pctFromLow52, 0)}</b></div>
                                <div>CMP / 52w low: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.cmpOverLow52, 2)}x</b></div>
                                <div>RS Rating (vs tracked {label.toLowerCase()}): <RSRatingBadge rsRating={t.rsRating} /></div>
                                <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                                <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                              </div>
                            ) : <div style={{ color: T.textDim, fontSize: 12 }}>No price data for this {labelSingular}.</div>}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function matchesMASignals(signals, streaks, filter, allPeriods) {
  if (!filter || !signals) return true;
  const { selected, mode } = filter;
  for (const sel of selected) {
    if (!signals[sel.period]) return false;
    const s = streaks?.[sel.period]?.streak;
    if (sel.min != null && (s == null || s < sel.min)) return false;
    if (sel.max != null && (s == null || s > sel.max)) return false;
  }
  if (mode === "exact") {
    const selectedPeriods = selected.map((s) => s.period);
    for (const p of allPeriods) { if (!selectedPeriods.includes(p) && signals[p]) return false; }
  }
  return true;
}

function MASignalFilterPopover({ title, periods, prefix, current, onApply, onClear, onClose }) {
  const initial = new Map((current?.selected || []).map((s) => [s.period, { min: s.min, max: s.max }]));
  const [selected, setSelected] = useState(initial);
  const [mode, setMode] = useState(current?.mode || "exact");
  const toggle = (p) => setSelected((prev) => { const n = new Map(prev); n.has(p) ? n.delete(p) : n.set(p, { min: null, max: null }); return n; });
  const setRange = (p, field, val) => setSelected((prev) => { const n = new Map(prev); n.set(p, { ...n.get(p), [field]: val === "" ? null : Number(val) }); return n; });
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", right: 0, zIndex: 30, background: T.surfaceAlt,
      border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, minWidth: 240,
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)", textTransform: "none", letterSpacing: "normal", fontWeight: 400,
    }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {periods.map((p) => (
          <label key={p} style={{
            display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "4px 8px", borderRadius: 4, cursor: "pointer",
            border: `1px solid ${selected.has(p) ? T.gold : T.border}`, color: selected.has(p) ? T.gold : T.textDim,
            background: selected.has(p) ? "rgba(201,162,39,0.12)" : "transparent",
          }}>
            <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} style={{ display: "none" }} />
            {prefix}{p}
          </label>
        ))}
      </div>
      {selected.size > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
          {Array.from(selected.entries()).map(([p, r]) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ width: 34, color: T.gold, fontWeight: 600 }}>{prefix}{p}</span>
              <span style={{ color: T.textDim }}>days:</span>
              <input type="number" placeholder="Min" value={r.min ?? ""} onChange={(e) => setRange(p, "min", e.target.value)}
                style={{ width: 50, padding: "3px 5px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 11 }} />
              <span style={{ color: T.textDim }}>–</span>
              <input type="number" placeholder="Max" value={r.max ?? ""} onChange={(e) => setRange(p, "max", e.target.value)}
                style={{ width: 50, padding: "3px 5px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 11 }} />
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, fontSize: 11 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", color: mode === "exact" ? T.text : T.textDim }}>
          <input type="radio" name={`mode-${prefix}`} checked={mode === "exact"} onChange={() => setMode("exact")} /> Only these signals (exact)
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", color: mode === "and" ? T.text : T.textDim }}>
          <input type="radio" name={`mode-${prefix}`} checked={mode === "and"} onChange={() => setMode("and")} /> Includes these (others allowed)
        </label>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => {
          const arr = Array.from(selected.entries()).map(([period, r]) => ({ period, min: r.min ?? null, max: r.max ?? null }));
          onApply(arr.length ? { selected: arr, mode } : null); onClose();
        }} style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Apply</button>
        <button onClick={() => { onClear(); onClose(); }}
          style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>Clear</button>
      </div>
    </div>
  );
}

// ---------- Alerts (recurring master-management tasks, persist until marked done) ----------
function quarterEndsForYear(y) {
  return [2, 5, 8, 11].map((m) => new Date(y, m + 1, 0)); // last day of Mar/Jun/Sep/Dec
}
function nextQuarterEndOnOrAfter(fromDate) {
  const y = fromDate.getFullYear();
  for (let yy = y; yy <= y + 1; yy++) {
    for (const d of quarterEndsForYear(yy)) {
      if (d >= new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate())) return d;
    }
  }
  return quarterEndsForYear(y + 1)[0];
}
function advanceDueDate(dueDateStr, recurrence) {
  const d = new Date(dueDateStr + "T00:00:00");
  if (recurrence === "quarterly") {
    const next = new Date(d); next.setDate(next.getDate() + 1);
    return nextQuarterEndOnOrAfter(next).toISOString().slice(0, 10);
  }
  if (recurrence === "monthly") { const n = new Date(d.getFullYear(), d.getMonth() + 2, 0); return n.toISOString().slice(0, 10); }
  if (recurrence === "yearly") { const n = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()); return n.toISOString().slice(0, 10); }
  return null; // "none" — one-off, no next occurrence
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

const DEFAULT_ALERTS = [
  {
    id: "quarterly-universe-update",
    title: "Update stock universe (quarter close)",
    notes: "Recompute Meridian's tracked universe: include all stocks with Market Cap > ₹500 Cr as of today's close (plain >500 cutoff, no buffer). Update Company Master — add new qualifiers, flag/exclude dropouts (keep their historical data, don't delete).",
    dueDate: nextQuarterEndOnOrAfter(new Date()).toISOString().slice(0, 10),
    recurrence: "quarterly",
    status: "pending",
  },
];

function AlertsPanel({ alerts, onMarkDone, onAddAlert, onClose }) {
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ title: "", notes: "", dueDate: "", recurrence: "none" });
  const today = todayStr();
  const sorted = [...alerts].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", top: "120%", right: 0, zIndex: 40, background: T.surfaceAlt, border: `1px solid ${T.border}`,
      borderRadius: 8, padding: 12, width: 320, maxHeight: 420, overflowY: "auto", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 8 }}>Master management alerts</div>
      {sorted.length === 0 && <div style={{ fontSize: 12, color: T.textDim }}>No alerts.</div>}
      {sorted.map((a) => {
        const isDue = a.dueDate <= today;
        return (
          <div key={a.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: isDue ? T.loss : T.text }}>{isDue ? "● DUE — " : ""}{a.title}</span>
            </div>
            <div style={{ fontSize: 10.5, color: T.textDim, marginTop: 2 }}>Due {a.dueDate}{a.recurrence !== "none" ? ` · repeats ${a.recurrence}` : ""}</div>
            {a.notes && <div style={{ fontSize: 11, color: T.textDim, marginTop: 4, lineHeight: 1.4 }}>{a.notes}</div>}
            <button onClick={() => onMarkDone(a.id)} style={{
              marginTop: 6, padding: "4px 10px", borderRadius: 5, border: `1px solid ${T.gold}`,
              background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600,
            }}>Mark done{a.recurrence !== "none" ? " (schedules next)" : ""}</button>
          </div>
        );
      })}
      {showAdd ? (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title"
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
          <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Notes"
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
            <select value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value })}
              style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }}>
              <option value="none">One-off</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <button onClick={() => { if (draft.title && draft.dueDate) { onAddAlert(draft); setDraft({ title: "", notes: "", dueDate: "", recurrence: "none" }); setShowAdd(false); } }}
            style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 11, fontWeight: 600 }}>Add alert</button>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} style={{ marginTop: 10, padding: "5px 10px", borderRadius: 5, border: `1px dashed ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11 }}>+ Add alert</button>
      )}
    </div>
  );
}

// ---------- Breakout Ideas Screen ----------
// ---------- Golden Breakout Screen ----------
const GB_FILTERABLE = {
  changePct: { label: "1D %", accessor: (s) => s.tech?.changePct },
  fundScore: { label: "Fund Score", accessor: (s) => s.fund?.score?.score },
  separationPct: { label: "Separation %", accessor: (s) => s.tech?.separationPct },
  freshnessDays: { label: "Freshness (d)", accessor: (s) => s.tech?.goldenCrossStreak?.streak },
  ma200SlopePct: { label: "200DMA Slope %", accessor: (s) => s.tech?.ma200SlopePct },
  volBreakout: { label: "Vol Breakout %", accessor: (s) => s.tech?.volBreakoutPct },
};

function GoldenBreakoutScreen({ candidates, accent = T.gold, hasFundamentals = true, itemLabel = "Stock" }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("separationPct");
  const [sortDir, setSortDir] = useState(-1);
  const [expanded, setExpanded] = useState(null);
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);

  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => setColFilters({});

  const toggleSort = (key) => { if (sortKey === key) setSortDir((d) => -d); else { setSortKey(key); setSortDir(-1); } };
  const sortArrow = (key) => {
    if (sortKey !== key) return null;
    const up = sortDir === 1;
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${accent}` : "none", borderTop: up ? "none" : `6px solid ${accent}`,
      }} />
    );
  };
  const FilterableTh = ({ colKey, label }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{label}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? accent : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={label} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const filtered = useMemo(() => {
    let list = candidates.filter((s) =>
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = GB_FILTERABLE[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      })
    );
    list = [...list].sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "fundScore") return row.fund?.score?.score ?? -Infinity;
        if (sortKey === "separationPct") return row.tech?.separationPct ?? -Infinity;
        if (sortKey === "freshnessDays") return row.tech?.goldenCrossStreak?.streak ?? Infinity;
        if (sortKey === "ma200SlopePct") return row.tech?.ma200SlopePct ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [candidates, search, sortKey, sortDir, colFilters]);

  return (
    <div style={{ padding: "16px 24px 40px" }} onClick={() => setOpenFilterKey(null)}>
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 16, lineHeight: 1.6 }}>
        <b style={{ color: T.text }}>{candidates.length} candidate{candidates.length === 1 ? "" : "s"}</b> — Golden Cross model, five backtested gates: price above 50DMA above 200DMA, 200DMA rising, separation ≥3%, cross freshness ≤15 days, price above 8DMA.
        {hasFundamentals ? " No RS, no fundamentals, no volatility filter, no bucketing — each was tested against 5 years of real equity price history and either didn't earn its place or actively hurt results." : " Same five gates as the equities model — thresholds were validated on equities specifically and haven't yet been separately backtested for this asset class."} Sorted by separation width, then freshness.{hasFundamentals ? " Fund Score and Volume Breakout are shown for your own reference — neither gates nor ranks the list." : " Volume Breakout is shown for your own reference — it doesn't gate or rank the list."}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ position: "relative" }}>
          <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${itemLabel.toLowerCase()}...`}
            style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 180 }} />
        </div>
        {Object.keys(colFilters).length > 0 && (
          <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Filter size={11} color={accent} /> {Object.keys(colFilters).length} filter{Object.keys(colFilters).length > 1 ? "s" : ""} active <X size={11} />
          </button>
        )}
      </div>

      {candidates.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          No {pluralizeLower(itemLabel)} currently clear all five gates.
        </div>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
          <table>
            <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
              <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th></th>
                <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>{itemLabel}{sortArrow("Name")}</th>
                <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                <FilterableTh colKey="changePct" label="1D %" />
                {hasFundamentals && <FilterableTh colKey="fundScore" label="Fund Score" />}
                <FilterableTh colKey="separationPct" label="Separation %" />
                <FilterableTh colKey="freshnessDays" label="Freshness (d)" />
                <FilterableTh colKey="ma200SlopePct" label="200DMA Slope %" />
                <FilterableTh colKey="volBreakout" label="Vol Brk %" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const isOpen = expanded === s.ISIN;
                const t = s.tech, f = s.fund;
                return (
                  <React.Fragment key={s.ISIN}>
                    <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                      style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                      <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                      <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}</div></td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? `₹${fmtNum(t.cmp, 2)}` : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                      {hasFundamentals && <td><FundTierBadge fundScore={f?.score} /></td>}
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.separationPct, 1) : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t?.goldenCrossStreak?.streak ?? "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.ma200SlopePct, 1) : "—"}</td>
                      <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? accent : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={hasFundamentals ? 9 : 8} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                          <div style={{ display: "grid", gridTemplateColumns: hasFundamentals ? "1fr 1fr" : "1fr", gap: 24 }}>
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8 }}>Golden Breakout gates</div>
                              <div style={{ fontSize: 12, lineHeight: 2 }}>
                                <div>Golden Cross (50DMA &gt; 200DMA): <b style={{ color: T.gain }}>Yes</b>, price above 50DMA: <b style={{ color: T.gain }}>Yes</b></div>
                                <div>200DMA rising: <b style={{ color: T.gain }}>Yes</b> ({fmtPct(t?.ma200SlopePct, 2)})</div>
                                <div>Separation: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtPct(t?.separationPct, 2)}</b> (min 3%)</div>
                                <div>Freshness: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t?.goldenCrossStreak?.streak}d</b> (max 15d)</div>
                                <div>Price above 8DMA: <b style={{ color: T.gain }}>Yes</b> (MA8: ₹{fmtNum(t?.mas?.[8], 2)})</div>
                              </div>
                            </div>
                            {hasFundamentals && (
                            <div>
                              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: accent, marginBottom: 8 }}>Fundamentals (reference only — {f?.latestFY || "—"})</div>
                              {f ? (
                                <>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: T.textDim }}>Composite score:</span>
                                    <FundTierBadge fundScore={f.score} />
                                  </div>
                                  <FundRow label="ROE" block={f.roe} />
                                  <FundRow label="ROCE" block={f.roce} />
                                  <FundRow label="EPS growth" block={f.epsGrowth} />
                                  <FundRow label="Sales growth" block={f.salesGrowth} />
                                  <FundRow label="Debt/Equity" block={f.debtEquity} isPercent={false} />
                                </>
                              ) : <div style={{ color: T.textDim, fontSize: 12 }}>No fundamentals data for this stock.</div>}
                            </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Market Breadth Screen ----------
// ---------- Sectoral Screen (base data view for the derived industry-pool series) ----------
function SectoralScreen({ computed, accent }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() => {
    let list = computed.filter((s) => search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()));
    list = [...list].sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "rsRating") return row.tech?.rsRating?.rating ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, search, sortKey, sortDir]);

  const toggleSort = (k) => { if (sortKey === k) setSortDir((d) => -d); else { setSortKey(k); setSortDir(1); } };

  if (computed.length === 0) {
    return <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>No Industry Group data yet — load stock data with price history on the Equities tab first (needs at least 3 stocks per industry group to build a meaningful synthetic index).</div>;
  }

  return (
    <div style={{ padding: "16px 24px 40px" }}>
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 16, lineHeight: 1.6 }}>
        {computed.length} industries — each a synthetic, equal-weighted price index built entirely from your loaded Equities data, run through the same technical engine as any real instrument. Industries with fewer than 3 constituents are excluded as too thin to average meaningfully. Read-only; nothing to upload here.
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ position: "relative", display: "inline-block" }}>
          <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search industry..."
            style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 200 }} />
        </div>
      </div>
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table>
          <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
            <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <th></th>
              <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>Industry</th>
              <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>Index Level</th>
              <th onClick={() => toggleSort("changePct")} style={{ cursor: "pointer" }}>1D %</th>
              <th onClick={() => toggleSort("rsRating")} style={{ cursor: "pointer" }}>RS Rating</th>
              <th>Price vs MA</th>
              <th>MA vs MA</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const isOpen = expanded === s.ISIN;
              const t = s.tech;
              return (
                <React.Fragment key={s.ISIN}>
                  <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                    style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                    <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                    <td style={{ fontWeight: 600 }}>{s.Name}</td>
                    <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? fmtNum(t.cmp, 2) : "—"}</td>
                    <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                    <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                    <td>{t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                    <td>{t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}</td>
                  </tr>
                  {isOpen && t && (
                    <tr>
                      <td colSpan={7} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ fontSize: 12, lineHeight: 2 }}>
                          <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.low52, 2)} – {fmtNum(t.high52, 2)}</b></div>
                          <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                          <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Market Breadth Screen (Equities only — single flat reading, no bucketing) ----------
function MarketBreadthScreen({ series }) {
  const chartData = series.map((p, i) => ({
    i,
    pctAbove200: p.pctAbove200 != null ? Number(p.pctAbove200.toFixed(1)) : null,
    ma30: p.pctAbove200MA30 != null ? Number(p.pctAbove200MA30.toFixed(1)) : null,
    ma100: p.pctAbove200MA100 != null ? Number(p.pctAbove200MA100.toFixed(1)) : null,
    ma200: p.pctAbove200MA200 != null ? Number(p.pctAbove200MA200.toFixed(1)) : null,
    hlRatio: p.hlRatio != null ? Number(Math.min(p.hlRatio, 10).toFixed(2)) : 10,
  }));

  if (series.length === 0) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
        No breadth data yet. Load stock data with price history on the Equities tab first.
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 24px 40px" }}>
      <div style={{ fontSize: 11, color: T.textDim, marginBottom: 16, lineHeight: 1.5 }}>
        Whole-market breadth — % of your entire loaded stock universe trading above its own 200-day moving average, plus new-highs vs. new-lows. No market-cap segmentation.
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 10 }}>% of stocks above their 200-day moving average — with 30/100/200-day smoothing</div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
            <XAxis dataKey="i" tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <Tooltip contentStyle={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="pctAbove200" name="Real (daily)" stroke={T.gold} dot={false} strokeWidth={1.75} />
            <Line type="monotone" dataKey="ma30" name="30d avg" stroke={T.loss} dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="ma100" name="100d avg" stroke={T.amber} dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="ma200" name="200d avg" stroke={T.gain} dot={false} strokeWidth={1} strokeDasharray="4 2" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.gold, marginBottom: 10 }}>New highs ÷ new lows ratio (capped at 10 for readability)</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
            <XAxis dataKey="i" tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <YAxis tick={{ fill: T.textDim, fontSize: 10 }} tickLine={false} />
            <Tooltip contentStyle={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, fontSize: 11 }} />
            <Line type="monotone" dataKey="hlRatio" stroke={T.gain} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [activeAssetClass, setActiveAssetClass] = useState("equities");
  const [equitiesSubTab, setEquitiesSubTab] = useState("stocks");
  const [commoditiesSubTab, setCommoditiesSubTab] = useState("base");
  const [indicesSubTab, setIndicesSubTab] = useState("base");
  const [cryptoSubTab, setCryptoSubTab] = useState("base");
  const [currenciesSubTab, setCurrenciesSubTab] = useState("base");
  const [alerts, setAlerts] = useState(DEFAULT_ALERTS);
  const [showAlerts, setShowAlerts] = useState(false);
  const [master, setMaster] = useState([]);
  const [fundamentals, setFundamentals] = useState([]);
  const [prices, setPrices] = useState([]);
  const [usingSample, setUsingSample] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sectorFilter, setSectorFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("Name");
  const [sortDir, setSortDir] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const [status, setStatus] = useState("");

  // ---- Watchlists ----
  const [watchlists, setWatchlists] = useState({});   // { name: [ISIN, ...] }
  const [activeView, setActiveView] = useState("All"); // "All" or a watchlist name
  const [selected, setSelected] = useState(new Set());
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newListDraft, setNewListDraft] = useState("");
  const [creatingList, setCreatingList] = useState(false);

  // ---- Universe management (add/remove tracked stocks) ----
  const [showManage, setShowManage] = useState(false);
  const [manageSearch, setManageSearch] = useState("");
  const [newStock, setNewStock] = useState({ ISIN: "", Symbol: "", Name: "", Sector: "", MarketCap: "", PE: "" });

  // ---- Column filters (numeric range, per column) ----
  const [colFilters, setColFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);
  const applyFilter = (key, cfg) => setColFilters((prev) => ({ ...prev, [key]: cfg }));
  const clearFilter = (key) => setColFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const clearAllFilters = () => { setColFilters({}); setMaFilters({ S: null, M: null }); };
  const [maFilters, setMaFilters] = useState({ S: null, M: null });

  useEffect(() => {
    (async () => {
      let loadedMasterCount = 0, loadedPriceCount = 0, hadMetaKey = false;
      try {
        const metaRes = await window.storage.get("screener-meta", false);
        if (metaRes && metaRes.value) {
          hadMetaKey = true;
          const parsed = JSON.parse(metaRes.value);
          setMaster(parsed.master || []);
          setFundamentals(parsed.fundamentals || []);
          setUsingSample(parsed.usingSample || false);
          loadedMasterCount = (parsed.master || []).length;
        }
        const loadedPrices = await loadChunkedArray("screener-prices");
        setPrices(loadedPrices);
        loadedPriceCount = loadedPrices.length;
      } catch (e) { console.error("Load from storage failed", e); }
      try {
        const wl = await window.storage.get("screener-watchlists", false);
        if (wl && wl.value) setWatchlists(JSON.parse(wl.value));
      } catch (e) { /* no watchlists yet */ }
      try {
        const al = await window.storage.get("meridian-alerts", false);
        if (al && al.value) setAlerts(JSON.parse(al.value));
        else await window.storage.set("meridian-alerts", JSON.stringify(DEFAULT_ALERTS), false);
      } catch (e) { /* no alerts yet */ }
      if (hadMetaKey && loadedMasterCount > 0) {
        setStatus(`Restored from last session: ${loadedMasterCount} stocks, ${loadedPriceCount.toLocaleString("en-IN")} price rows.`);
      } else if (hadMetaKey && loadedMasterCount === 0) {
        setStatus("⚠ Found saved settings but no stocks — a previous save may not have completed.");
      }
      setLoaded(true);
    })();
  }, []);

  const persistAlerts = useCallback(async (next) => {
    try { await window.storage.set("meridian-alerts", JSON.stringify(next), false); } catch (e) { console.error(e); }
  }, []);

  const markAlertDone = (id) => {
    setAlerts((prev) => {
      const next = prev
        .map((a) => {
          if (a.id !== id) return a;
          const nextDue = advanceDueDate(a.dueDate, a.recurrence);
          return nextDue ? { ...a, dueDate: nextDue } : null; // one-off alerts are removed once done
        })
        .filter(Boolean);
      persistAlerts(next);
      return next;
    });
  };

  const addAlert = (draft) => {
    setAlerts((prev) => {
      const next = [...prev, { id: `alert-${Date.now()}`, status: "pending", ...draft }];
      persistAlerts(next);
      return next;
    });
  };

  const dueAlertCount = alerts.filter((a) => a.dueDate <= todayStr()).length;

  const persistWatchlists = useCallback(async (next) => {
    try { await window.storage.set("screener-watchlists", JSON.stringify(next), false); } catch (e) { console.error(e); }
  }, []);

  const createWatchlist = (name) => {
    const trimmed = name.trim();
    if (!trimmed || watchlists[trimmed]) return;
    const next = { ...watchlists, [trimmed]: [] };
    setWatchlists(next);
    persistWatchlists(next);
    return trimmed;
  };

  const addSelectedToWatchlist = (name) => {
    const next = { ...watchlists, [name]: Array.from(new Set([...(watchlists[name] || []), ...selected])) };
    setWatchlists(next);
    persistWatchlists(next);
    setSelected(new Set());
    setShowAddMenu(false);
    setStatus(`Added ${selected.size} stock(s) to "${name}".`);
  };

  const addSelectedToNewWatchlist = () => {
    const name = createWatchlist(newListDraft);
    if (!name) return;
    const next = { ...watchlists, [name]: Array.from(selected) };
    setWatchlists(next);
    persistWatchlists(next);
    setSelected(new Set());
    setShowAddMenu(false);
    setCreatingList(false);
    setNewListDraft("");
    setActiveView(name);
    setStatus(`Created "${name}" with ${selected.size} stock(s).`);
  };

  const removeFromWatchlist = (name, isin) => {
    const next = { ...watchlists, [name]: (watchlists[name] || []).filter((x) => x !== isin) };
    setWatchlists(next);
    persistWatchlists(next);
  };

  const deleteWatchlist = (name) => {
    const next = { ...watchlists };
    delete next[name];
    setWatchlists(next);
    persistWatchlists(next);
    if (activeView === name) setActiveView("All");
  };

  const toggleSelect = (isin) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(isin)) next.delete(isin); else next.add(isin);
      return next;
    });
  };

  const persist = useCallback(async (next) => {
    try {
      await window.storage.set("screener-meta", JSON.stringify({
        master: next.master, fundamentals: next.fundamentals, usingSample: next.usingSample,
      }), false);
      await saveChunkedArray("screener-prices", next.prices || []);
      // Lightweight verification — checks the recorded row count, does NOT reload and
      // re-parse the full dataset (that reload was itself doubling peak memory usage on
      // large uploads and is the likely cause of the upload crash).
      const pricesOk = await verifyChunkedArraySaved("screener-prices", (next.prices || []).length);
      const checkMeta = await window.storage.get("screener-meta", false);
      const metaOk = checkMeta && checkMeta.value && JSON.parse(checkMeta.value).master?.length === (next.master || []).length;
      if (!metaOk || !pricesOk) {
        console.error("Persist verification failed", { metaOk, pricesOk });
        return false;
      }
      return true;
    } catch (e) { console.error(e); return false; }
  }, []);

  const loadSample = async () => {
    setMaster(SAMPLE_MASTER); setFundamentals(SAMPLE_FUND); setPrices(SAMPLE_PRICES);
    setUsingSample(true);
    const ok = await persist({ master: SAMPLE_MASTER, fundamentals: SAMPLE_FUND, prices: SAMPLE_PRICES, usingSample: true });
    setStatus(ok ? "Loaded demo data (synthetic — not real financials)." : "⚠ Demo data loaded but failed to save — it won't survive a reload.");
  };

  const clearAll = async () => {
    setMaster([]); setFundamentals([]); setPrices([]); setUsingSample(false);
    try { await window.storage.delete("screener-meta", false); } catch (e) {}
    await deleteChunkedArray("screener-prices");
    setStatus("Cleared.");
  };

  const addStockToUniverse = async () => {
    const isin = newStock.ISIN.trim();
    if (!isin || !newStock.Symbol.trim()) { setStatus("ISIN and Symbol are required to add a stock."); return; }
    if (master.some((m) => m.ISIN === isin)) { setStatus(`${isin} is already in the universe.`); return; }
    const row = {
      ISIN: isin, Symbol: newStock.Symbol.trim(), Name: newStock.Name.trim() || newStock.Symbol.trim(),
      Sector: newStock.Sector.trim() || "Unclassified",
      MarketCap: newStock.MarketCap === "" ? null : Number(newStock.MarketCap),
      PE: newStock.PE === "" ? null : Number(newStock.PE),
    };
    const nextMaster = [...master, row];
    setMaster(nextMaster);
    setUsingSample(false);
    const ok = await persist({ master: nextMaster, fundamentals, prices, usingSample: false });
    setNewStock({ ISIN: "", Symbol: "", Name: "", Sector: "", MarketCap: "", PE: "" });
    setStatus(ok
      ? `Added ${row.Symbol} to the universe. Upload/add its fundamentals and price history to see computed fields.`
      : `⚠ Added ${row.Symbol} but the save failed — it won't survive a reload.`);
  };

  const removeStockFromUniverse = async (isin, name) => {
    if (!window.confirm(`Remove ${name} (${isin}) from the tracked universe? This also clears its fundamentals, price history, and watchlist entries.`)) return;
    const nextMaster = master.filter((m) => m.ISIN !== isin);
    const nextFund = fundamentals.filter((f) => f.ISIN !== isin);
    const nextPrices = prices.filter((p) => p.ISIN !== isin);
    setMaster(nextMaster); setFundamentals(nextFund); setPrices(nextPrices);
    const ok = await persist({ master: nextMaster, fundamentals: nextFund, prices: nextPrices, usingSample });

    const nextWatchlists = Object.fromEntries(
      Object.entries(watchlists).map(([n, list]) => [n, list.filter((x) => x !== isin)])
    );
    setWatchlists(nextWatchlists);
    persistWatchlists(nextWatchlists);
    setSelected((prev) => { const next = new Set(prev); next.delete(isin); return next; });
    setStatus(ok ? `Removed ${name} from the universe.` : `⚠ Removed ${name} locally, but the save failed — it may reappear on reload.`);
  };

  const upsertByISIN = (existing, incoming) => {
    if (existing.length === 0) return incoming; // fast path for an initial full load — skip the filter/spread copy entirely
    const incomingISINs = new Set(incoming.map((r) => r.ISIN));
    return [...existing.filter((r) => !incomingISINs.has(r.ISIN)), ...incoming];
  };

  // Numeric fields per upload kind — used to convert only what actually needs to be a
  // number, instead of PapaParse's dynamicTyping, which runs expensive generic type-sniffing
  // on every single cell (including ISIN/Date strings) and was almost certainly the real
  // cause of the price-upload crash: 807,339 rows × 6 columns is ~4.8M cells of that
  // sniffing, entirely synchronous on the main thread.
  const NUMERIC_FIELDS = {
    master: new Set(["MarketCap", "PE", "PB"]),
    fundamentals: new Set(["ROE_Pct", "ROCE_Pct", "DebtEquity", "EPS", "Sales", "FixedAssets", "CWIP"]),
    prices: new Set(["High", "Low", "Close", "Volume"]),
  };

  const handleUpload = (file, kind) => {
    const numericFields = NUMERIC_FIELDS[kind] || new Set();
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      transform: (value, field) => (numericFields.has(field) ? (value === "" ? null : Number(value)) : value),
      complete: async (res) => {
        const rows = res.data;
        let nextMaster = master, nextFund = fundamentals, nextPrices = prices;
        // master/fundamentals/prices MERGE by ISIN — an upload only touches the stocks it contains,
        // so you can add or refresh one stock without wiping the rest of the universe.
        if (kind === "master") { nextMaster = upsertByISIN(master, rows); setMaster(nextMaster); }
        if (kind === "fundamentals") { nextFund = upsertByISIN(fundamentals, rows); setFundamentals(nextFund); }
        if (kind === "prices") { nextPrices = upsertByISIN(prices, rows); setPrices(nextPrices); }
        setUsingSample(false);
        setStatus(`Saving ${rows.length} rows to browser storage — don't close or navigate away yet...`);
        const ok = await persist({ master: nextMaster, fundamentals: nextFund, prices: nextPrices, usingSample: false });
        setStatus(ok
          ? `Saved. ${rows.length} rows loaded into ${kind} (merged by stock) and persisted for next time.`
          : `⚠ Save failed for ${kind} — data is showing now but will NOT survive a reload. Try again, or check the browser console.`);
      },
      error: (err) => setStatus(`Error parsing file: ${err.message}`),
    });
  };

  const closesById = useMemo(() => closesByKeyFromPrices(prices, "ISIN"), [prices]);
  const rsUniverse = useMemo(() => computeRSUniverse(closesById), [closesById]);
  const computed = useMemo(() => {
    const base = computeAll(master, fundamentals, prices);
    const fundScores = computeFundamentalScores(base);
    return base.map((s) => {
      const tech = s.tech ? { ...s.tech, rsRating: rsUniverse[s.ISIN] || null } : s.tech;
      const fund = s.fund ? { ...s.fund, score: fundScores[s.ISIN] || null } : s.fund;
      // Computed P/E = CMP / latest EPS from the fundamentals file, replacing whatever
      // (usually blank) PE value came in via the Company Master upload — but falling back
      // to the uploaded/manual value when EPS data isn't available yet, rather than blanking it.
      const peComputed = tech && fund && fund.epsLatest ? tech.cmp / fund.epsLatest : null;
      return { ...s, tech, fund, PE: peComputed != null ? peComputed : s.PE };
    });
  }, [master, fundamentals, prices, rsUniverse]);

  // Market Breadth: single flat computation, no bucketing (removed — it was being computed
  // and then entirely discarded, since only the flat reading is ever displayed; this was
  // real wasted work, not just unused code — breadth alone is the single most expensive
  // computation in the app, walking up to 500 days across every stock).
  const needsBreadthCompute = activeAssetClass === "equities" && equitiesSubTab === "breadth";
  const breadthSeries = useMemo(
    () => (needsBreadthCompute ? computeBreadthSeries(master, closesById) : []),
    [master, closesById, needsBreadthCompute]
  );

  // Golden Breakout: a single flat filter+sort over the already-computed stock list — no
  // bucketing, no cross-population ranking, so this is cheap (O(n)) and doesn't need the
  // same eager-computation caution as breadth. Still gated to the tab being open, for
  // consistency and to avoid any unnecessary work while sitting on the base data screen.
  const goldenBreakoutCandidates = useMemo(
    () => (activeAssetClass === "equities" && equitiesSubTab === "breakout" ? runGoldenBreakoutScreener(computed) : []),
    [computed, activeAssetClass, equitiesSubTab]
  );

  // Sectoral: derived from Equities data, only computed when its sub-tabs are actually open.
  const needsSectoralCompute = activeAssetClass === "equities" && (equitiesSubTab === "sectoral" || equitiesSubTab === "sectoralBreakout");
  const sectoralComputed = useMemo(() => {
    if (!needsSectoralCompute) return [];
    const seriesBySector = computeSectoralSeries(master, prices);
    const sectorNames = Object.keys(seriesBySector);
    const closesBySector = {};
    sectorNames.forEach((name) => { closesBySector[name] = seriesBySector[name].map((r) => r.Close); });
    const rsUniverseSector = computeRSUniverse(closesBySector);
    return sectorNames.map((name) => {
      const tech = computeTechnicalBlock(seriesBySector[name]);
      return { ISIN: name, Name: name, Symbol: name, Sector: name, tech: tech ? { ...tech, rsRating: rsUniverseSector[name] || null } : tech, fund: null };
    });
  }, [master, prices, needsSectoralCompute]);
  const sectoralBreakoutCandidates = useMemo(
    () => (equitiesSubTab === "sectoralBreakout" ? runGoldenBreakoutScreener(sectoralComputed) : []),
    [sectoralComputed, equitiesSubTab]
  );

  const sectors = useMemo(() => ["All", ...Array.from(new Set(master.map((m) => m.Sector).filter(Boolean)))], [master]);

  const filtered = useMemo(() => {
    let list = computed.filter((s) =>
      (sectorFilter === "All" || s.Sector === sectorFilter) &&
      (search === "" || (s.Name || "").toLowerCase().includes(search.toLowerCase()) || (s.Symbol || "").toLowerCase().includes(search.toLowerCase())) &&
      (activeView === "All" || (watchlists[activeView] || []).includes(s.ISIN)) &&
      Object.entries(colFilters).every(([key, cfg]) => {
        const def = FILTERABLE_COLUMNS[key];
        if (!def) return true;
        const val = def.accessor(s);
        if (cfg.min != null && (val == null || val < cfg.min)) return false;
        if (cfg.max != null && (val == null || val > cfg.max)) return false;
        return true;
      }) &&
      matchesMASignals(s.tech?.sSignals, s.tech?.sStreaks, maFilters.S, [3, 8, 30, 50, 100, 200]) &&
      matchesMASignals(s.tech?.mSignals, s.tech?.mStreaks, maFilters.M, [3, 8, 30, 100])
    );
    list.sort((a, b) => {
      const get = (row) => {
        if (sortKey === "Name") return row.Name || "";
        if (sortKey === "Sector") return row.Sector || "";
        if (sortKey === "CMP") return row.tech?.cmp ?? -Infinity;
        if (sortKey === "changePct") return row.tech?.changePct ?? -Infinity;
        if (sortKey === "MarketCap") return row.MarketCap ?? -Infinity;
        if (sortKey === "PE") return row.PE ?? -Infinity;
        if (sortKey === "ROE") return row.fund?.roe?.lastYr ?? -Infinity;
        if (sortKey === "fundTier") return row.fund?.score?.score ?? -Infinity;
        if (sortKey === "RSI") return row.tech?.rsi ?? -Infinity;
        if (sortKey === "relStrength") return row.tech?.rsRating?.rating ?? -Infinity;
        if (sortKey === "pctFromHigh52") return row.tech?.pctFromHigh52 ?? -Infinity;
        if (sortKey === "pctFromLow52") return row.tech?.pctFromLow52 ?? -Infinity;
        if (sortKey === "volBreakout") return row.tech?.volBreakoutPct ?? -Infinity;
        return "";
      };
      const av = get(a), bv = get(b);
      if (typeof av === "string") return sortDir * av.localeCompare(bv);
      return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return list;
  }, [computed, sectorFilter, search, sortKey, sortDir, activeView, watchlists, colFilters, maFilters]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => -d); else { setSortKey(key); setSortDir(1); }
  };
  const sortArrow = (key) => {
    if (sortKey !== key) return null;
    const up = sortDir === 1;
    // CSS-drawn triangle instead of a unicode glyph — the ▲/▼ characters were
    // rendering invisibly on some iPad screens depending on font fallback, this is
    // guaranteed to render on every platform since it's a shape, not a character.
    return (
      <span style={{
        display: "inline-block", marginLeft: 5, width: 0, height: 0, verticalAlign: "middle",
        borderLeft: "4px solid transparent", borderRight: "4px solid transparent",
        borderBottom: up ? `6px solid ${T.gold}` : "none",
        borderTop: up ? "none" : `6px solid ${T.gold}`,
      }} />
    );
  };

  const FilterableTh = ({ colKey, label }) => (
    <th style={{ position: "relative" }}>
      <span onClick={() => toggleSort(colKey)} style={{ cursor: "pointer" }}>{label}{sortArrow(colKey)}</span>
      <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === colKey ? null : colKey); }}
        style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
        <Filter size={10} color={colFilters[colKey] ? T.gold : T.textDim} />
      </button>
      {openFilterKey === colKey && (
        <NumFilterPopover colKey={colKey} label={label} current={colFilters[colKey]}
          onApply={applyFilter} onClear={clearFilter} onClose={() => setOpenFilterKey(null)} />
      )}
    </th>
  );

  const hasData = master.length > 0;

  return (
    <div onClick={() => { setOpenFilterKey(null); setShowAlerts(false); }} style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <style>{FONTS}{`
        * { box-sizing: border-box; }
        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; padding: 8px 10px; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
        input, select { font-family: inherit; }
        button { font-family: inherit; cursor: pointer; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "18px 24px", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Serif', serif", fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", color: T.gold }}>Meridian</div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>Fundamental + technical signal ledger — NIFTY 50 pilot</div>
        </div>
        <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 14 }}>
          {hasData ? `${computed.length} stocks loaded${usingSample ? " · DEMO DATA" : ""}` : "No data loaded"}
          <span style={{ position: "relative" }}>
            <button onClick={() => setShowAlerts((v) => !v)} style={{
              padding: 6, borderRadius: 6, border: `1px solid ${T.border}`, background: showAlerts ? T.surfaceAlt : "transparent",
              display: "inline-flex", alignItems: "center", position: "relative",
            }}>
              <Bell size={14} color={dueAlertCount > 0 ? T.gold : T.textDim} />
              {dueAlertCount > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -4, background: T.loss, color: "#fff", borderRadius: "50%",
                  width: 14, height: 14, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700,
                }}>{dueAlertCount}</span>
              )}
            </button>
            {showAlerts && (
              <AlertsPanel alerts={alerts} onMarkDone={markAlertDone} onAddAlert={addAlert} onClose={() => setShowAlerts(false)} />
            )}
          </span>
        </div>
      </div>

      {/* Top-level asset class tabs */}
      <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
        {[
          { key: "equities", label: "Equities", accent: T.gold },
          { key: "commodities", label: "Commodities", accent: ASSET_CLASSES.commodities.accent },
          { key: "indices", label: "Global Indices", accent: ASSET_CLASSES.indices.accent },
          { key: "crypto", label: "Crypto", accent: ASSET_CLASSES.crypto.accent },
          { key: "currencies", label: "Currencies", accent: ASSET_CLASSES.currencies.accent },
        ].map((tab) => (
          <button key={tab.key} onClick={() => setActiveAssetClass(tab.key)} style={{
            padding: "10px 18px", border: "none", borderBottom: `2px solid ${activeAssetClass === tab.key ? tab.accent : "transparent"}`,
            background: "transparent", color: activeAssetClass === tab.key ? tab.accent : T.textDim, fontSize: 13, fontWeight: 600,
          }}>{tab.label}</button>
        ))}
      </div>

      {/* Sub-tabs, per asset class */}
      {activeAssetClass === "equities" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[
            { key: "stocks", label: "Stocks" }, { key: "breakout", label: "Golden Breakout" },
            { key: "sectoral", label: "Sectoral" }, { key: "sectoralBreakout", label: "Sectoral Breakout" },
            { key: "breadth", label: "Market Breadth" },
          ].map((tab) => (
            <button key={tab.key} onClick={() => setEquitiesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${equitiesSubTab === tab.key ? T.gold : "transparent"}`,
              background: "transparent", color: equitiesSubTab === tab.key ? T.gold : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "commodities" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Commodities" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setCommoditiesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${commoditiesSubTab === tab.key ? ASSET_CLASSES.commodities.accent : "transparent"}`,
              background: "transparent", color: commoditiesSubTab === tab.key ? ASSET_CLASSES.commodities.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "indices" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Global Indices" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setIndicesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${indicesSubTab === tab.key ? ASSET_CLASSES.indices.accent : "transparent"}`,
              background: "transparent", color: indicesSubTab === tab.key ? ASSET_CLASSES.indices.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "crypto" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Crypto" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setCryptoSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${cryptoSubTab === tab.key ? ASSET_CLASSES.crypto.accent : "transparent"}`,
              background: "transparent", color: cryptoSubTab === tab.key ? ASSET_CLASSES.crypto.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}
      {activeAssetClass === "currencies" && (
        <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
          {[{ key: "base", label: "Currencies" }, { key: "breakout", label: "Golden Breakout" }].map((tab) => (
            <button key={tab.key} onClick={() => setCurrenciesSubTab(tab.key)} style={{
              padding: "8px 14px", border: "none", borderBottom: `2px solid ${currenciesSubTab === tab.key ? ASSET_CLASSES.currencies.accent : "transparent"}`,
              background: "transparent", color: currenciesSubTab === tab.key ? ASSET_CLASSES.currencies.accent : T.textDim, fontSize: 11.5, fontWeight: 600,
            }}>{tab.label}</button>
          ))}
        </div>
      )}

      {activeAssetClass === "equities" && equitiesSubTab === "stocks" && (
      <>
      {/* Data controls */}
      <div style={{ padding: "16px 24px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { kind: "master", label: "Company master" },
            { kind: "fundamentals", label: "Fundamentals (annual)" },
            { kind: "prices", label: "Prices (daily EOD)" },
          ].map(({ kind, label }) => (
            <label key={kind} style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6,
              border: `1px solid ${T.border}`, fontSize: 12, color: T.text, background: T.surfaceAlt,
            }}>
              <Upload size={13} color={T.gold} /> {label}
              <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0], kind)} />
            </label>
          ))}
          <button onClick={loadSample} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "transparent", color: T.gold, fontSize: 12, fontWeight: 600 }}>
            Load demo data
          </button>
          <button onClick={() => setShowManage((v) => !v)} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: showManage ? T.surfaceAlt : "transparent", color: T.text, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ListPlus size={13} color={T.gold} /> Manage universe ({master.length})
          </button>
          <button onClick={clearAll} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <RotateCcw size={12} /> Clear
          </button>
          {status && <span style={{ fontSize: 11, color: T.textDim, marginLeft: 4 }}>{status}</span>}
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 10, lineHeight: 1.5 }}>
          <b style={{ color: T.text }}>CSV columns expected —</b> Company master: ISIN, Symbol, Name, Sector, IndustryGroup (broader sector for Sector RS), MarketCap, PE (auto-computed from CMP/latest EPS) · Fundamentals (one row per stock per FY, last 4 years): ISIN, FY, ROE_Pct, ROCE_Pct, DebtEquity, EPS, Sales, FixedAssets, CWIP · Prices (one row per stock per trading day, ~1yr+): ISIN, Date, Close, Volume, plus optional High, Low for more accurate volatility-contraction readings. Uploads merge in by stock — they only touch the ISINs they contain.
        </div>

        {showManage && (
          <div style={{ marginTop: 14, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 10 }}>Add a stock to the universe</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {["ISIN", "Symbol", "Name", "Sector"].map((f) => (
                <input key={f} value={newStock[f]} onChange={(e) => setNewStock({ ...newStock, [f]: e.target.value })} placeholder={f}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: f === "Name" ? 160 : 120 }} />
              ))}
              {["MarketCap", "PE"].map((f) => (
                <input key={f} value={newStock[f]} onChange={(e) => setNewStock({ ...newStock, [f]: e.target.value })} placeholder={f === "MarketCap" ? "MarketCap ₹Cr" : f}
                  type="number" style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 90 }} />
              ))}
              <button onClick={addStockToUniverse} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)", color: T.gold, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Plus size={12} /> Add stock
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: T.textDim, marginBottom: 10 }}>
              A stock added here has no fundamentals or price history yet — upload its data (merges in without touching anyone else) or wait for the next automated technicals refresh.
            </div>

            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8, marginTop: 14 }}>Current universe ({master.length})</div>
            <input value={manageSearch} onChange={(e) => setManageSearch(e.target.value)} placeholder="Filter..."
              style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160, marginBottom: 8 }} />
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {master.filter((m) => !manageSearch || (m.Name || "").toLowerCase().includes(manageSearch.toLowerCase()) || (m.Symbol || "").toLowerCase().includes(manageSearch.toLowerCase()))
                .map((m) => (
                  <div key={m.ISIN} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${T.border}`, fontSize: 12 }}>
                    <span>{m.Name} <span style={{ color: T.textDim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5 }}>{m.Symbol} · {m.ISIN}</span></span>
                    <button onClick={() => removeStockFromUniverse(m.ISIN, m.Name)} title="Remove from universe"
                      style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.loss, display: "inline-flex" }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              {master.length === 0 && <div style={{ color: T.textDim, fontSize: 12 }}>No stocks yet.</div>}
            </div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div style={{ padding: 60, textAlign: "center", color: T.textDim }}>
          Upload your CSVs or load demo data to see the screen.
        </div>
      ) : (
        <>
          {/* Watchlist tabs */}
          <div style={{ padding: "12px 24px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setActiveView("All")} style={{
              padding: "6px 14px", borderRadius: 16, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${activeView === "All" ? T.gold : T.border}`,
              background: activeView === "All" ? "rgba(201,162,39,0.12)" : "transparent",
              color: activeView === "All" ? T.gold : T.textDim,
            }}>All Stocks ({computed.length})</button>
            {Object.keys(watchlists).map((name) => (
              <span key={name} style={{ display: "inline-flex", alignItems: "center" }}>
                <button onClick={() => setActiveView(name)} style={{
                  padding: "6px 10px 6px 14px", borderRadius: "16px 0 0 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${activeView === name ? T.gold : T.border}`, borderRight: "none",
                  background: activeView === name ? "rgba(201,162,39,0.12)" : "transparent",
                  color: activeView === name ? T.gold : T.textDim, display: "inline-flex", alignItems: "center", gap: 5,
                }}><Star size={11} /> {name} ({(watchlists[name] || []).length})</button>
                <button onClick={() => deleteWatchlist(name)} title="Delete watchlist" style={{
                  padding: "6px 8px", borderRadius: "0 16px 16px 0", fontSize: 12, cursor: "pointer",
                  border: `1px solid ${activeView === name ? T.gold : T.border}`,
                  background: activeView === name ? "rgba(201,162,39,0.12)" : "transparent", color: T.textDim,
                }}><X size={11} /></button>
              </span>
            ))}
            {creatingList ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input autoFocus value={newListDraft} onChange={(e) => setNewListDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newListDraft.trim()) { setActiveView(createWatchlist(newListDraft)); setNewListDraft(""); setCreatingList(false); } if (e.key === "Escape") { setCreatingList(false); setNewListDraft(""); } }}
                  placeholder="Watchlist name..." style={{ padding: "5px 10px", borderRadius: 14, border: `1px solid ${T.gold}`, background: T.surface, color: T.text, fontSize: 12, width: 130 }} />
              </span>
            ) : (
              <button onClick={() => setCreatingList(true)} style={{
                padding: "6px 10px", borderRadius: 16, fontSize: 12, cursor: "pointer", border: `1px dashed ${T.border}`,
                background: "transparent", color: T.textDim, display: "inline-flex", alignItems: "center", gap: 4,
              }}><Plus size={11} /> New watchlist</button>
            )}
          </div>

          {/* Filters */}
          <div style={{ padding: "12px 24px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search size={13} color={T.textDim} style={{ position: "absolute", left: 8, top: 8 }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search stock..."
                style={{ padding: "6px 10px 6px 26px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, width: 160 }} />
            </div>
            <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }}>
              {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {(Object.keys(colFilters).length > 0 || maFilters.S || maFilters.M) && (
              <button onClick={clearAllFilters} style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Filter size={11} color={T.gold} /> {Object.keys(colFilters).length + (maFilters.S?1:0) + (maFilters.M?1:0)} filter{(Object.keys(colFilters).length + (maFilters.S?1:0) + (maFilters.M?1:0)) > 1 ? "s" : ""} active <X size={11} />
              </button>
            )}
            {selected.size > 0 && (
              <div style={{ position: "relative", marginLeft: "auto" }}>
                <button onClick={() => setShowAddMenu((v) => !v)} style={{
                  padding: "6px 12px", borderRadius: 6, border: `1px solid ${T.gold}`, background: "rgba(201,162,39,0.12)",
                  color: T.gold, fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6,
                }}><ListPlus size={13} /> Add {selected.size} to watchlist</button>
                {showAddMenu && (
                  <div style={{ position: "absolute", right: 0, top: "110%", background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 8, minWidth: 180, zIndex: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                    {Object.keys(watchlists).length > 0 && Object.keys(watchlists).map((name) => (
                      <div key={name} onClick={() => addSelectedToWatchlist(name)} style={{ padding: "7px 8px", fontSize: 12, cursor: "pointer", borderRadius: 5, color: T.text }}
                        onMouseEnter={(e) => e.currentTarget.style.background = T.surface} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                        {name} ({(watchlists[name] || []).length})
                      </div>
                    ))}
                    <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6, display: "flex", gap: 4 }}>
                      <input value={newListDraft} onChange={(e) => setNewListDraft(e.target.value)} placeholder="New watchlist..."
                        onKeyDown={(e) => e.key === "Enter" && addSelectedToNewWatchlist()}
                        style={{ flex: 1, padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12 }} />
                      <button onClick={addSelectedToNewWatchlist} style={{ padding: "5px 8px", borderRadius: 5, border: `1px solid ${T.gold}`, background: "transparent", color: T.gold, fontSize: 12 }}>Add</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Table */}
          <div style={{ padding: "0 24px 40px", overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
            {filtered.length === 0 && activeView !== "All" ? (
              <div style={{ padding: 40, textAlign: "center", color: T.textDim, fontSize: 13 }}>
                "{activeView}" is empty. Select stocks in "All Stocks" and add them here.
              </div>
            ) : (
            <table>
              <thead style={{ position: "sticky", top: 0, zIndex: 15, background: T.bg }}>
                <tr style={{ borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th></th>
                  <th></th>
                  <th onClick={() => toggleSort("Name")} style={{ cursor: "pointer" }}>Stock{sortArrow("Name")}</th>
                  <th onClick={() => toggleSort("Sector")} style={{ cursor: "pointer" }}>Sector{sortArrow("Sector")}</th>
                  <th onClick={() => toggleSort("CMP")} style={{ cursor: "pointer" }}>CMP{sortArrow("CMP")}</th>
                  <FilterableTh colKey="changePct" label="1D %" />
                  <FilterableTh colKey="MarketCap" label="Mkt Cap" />
                  <FilterableTh colKey="PE" label="P/E" />
                  <FilterableTh colKey="ROE" label="ROE (LY)" />
                  <FilterableTh colKey="fundTier" label="Fund Score" />
                  <FilterableTh colKey="RSI" label="RSI" />
                  <FilterableTh colKey="relStrength" label="RS Rating" />
                  <FilterableTh colKey="pctFromHigh52" label="% fr 52wH" />
                  <FilterableTh colKey="pctFromLow52" label="% fr 52wL" />
                  <FilterableTh colKey="volBreakout" label="Vol Brk %" />
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    Price vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maS" ? null : "maS"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.S ? T.gold : T.textDim} />
                    </button>
                    {openFilterKey === "maS" && (
                      <MASignalFilterPopover title="Filter: Price vs Moving Average" periods={[3, 8, 30, 50, 100, 200]} prefix="S"
                        current={maFilters.S} onApply={(cfg) => setMaFilters((f) => ({ ...f, S: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, S: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th style={{ position: "relative" }} title="Sort not yet available for moving-average columns">
                    MA vs MA
                    <button onClick={(e) => { e.stopPropagation(); setOpenFilterKey(openFilterKey === "maM" ? null : "maM"); }}
                      style={{ marginLeft: 4, padding: 2, border: "none", background: "transparent", cursor: "pointer", verticalAlign: "middle" }}>
                      <Filter size={10} color={maFilters.M ? T.gold : T.textDim} />
                    </button>
                    {openFilterKey === "maM" && (
                      <MASignalFilterPopover title="Filter: MA vs MA" periods={[3, 8, 30, 100]} prefix="M"
                        current={maFilters.M} onApply={(cfg) => setMaFilters((f) => ({ ...f, M: cfg }))}
                        onClear={() => setMaFilters((f) => ({ ...f, M: null }))} onClose={() => setOpenFilterKey(null)} />
                    )}
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const isOpen = expanded === s.ISIN;
                  const t = s.tech, f = s.fund;
                  return (
                    <React.Fragment key={s.ISIN}>
                      <tr onClick={() => setExpanded(isOpen ? null : s.ISIN)}
                        style={{ borderBottom: `1px solid ${T.border}`, fontSize: 12.5, cursor: "pointer", background: isOpen ? T.surfaceAlt : "transparent" }}>
                        <td onClick={(e) => { e.stopPropagation(); toggleSelect(s.ISIN); }}>
                          <input type="checkbox" checked={selected.has(s.ISIN)} onChange={() => {}} style={{ cursor: "pointer" }} />
                        </td>
                        <td>{isOpen ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}</td>
                        <td style={{ fontWeight: 600 }}>{s.Name}<div style={{ fontSize: 10, color: T.textDim, fontFamily: "'IBM Plex Mono', monospace" }}>{s.Symbol}</div></td>
                        <td style={{ color: T.textDim }}>{s.Sector}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t ? `₹${fmtNum(t.cmp, 2)}` : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.changePct > 0 ? T.gain : t?.changePct < 0 ? T.loss : T.textDim }}>{t ? fmtPct(t.changePct) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{s.MarketCap != null ? fmtCr(s.MarketCap) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(s.PE)}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{f ? fmtPct(f.roe.lastYr) : "—"}</td>
                        <td><FundTierBadge fundScore={f?.score} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.rsi > 70 ? T.loss : t?.rsi < 30 ? T.gain : T.text }}>{t ? fmtNum(t.rsi) : "—"}</td>
                        <td><RSRatingBadge rsRating={t?.rsRating} /></td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.textDim }}>{t ? fmtPct(t.pctFromHigh52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{t ? fmtPct(t.pctFromLow52, 0) : "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", color: t?.volBreakoutPct > 150 ? T.gold : T.textDim, fontWeight: t?.volBreakoutPct > 150 ? 700 : 400 }}>{t && t.volBreakoutPct != null ? `${fmtNum(t.volBreakoutPct, 0)}%` : "—"}</td>
                        <td>
                          {t && [3, 8, 30, 50, 100, 200].map((n) => <SignalPill key={n} active={t.sSignals[n]} label={`S${n}`} streak={t.sStreaks?.[n]?.streak} capped={t.sStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}
                        </td>
                        <td>
                          {t && [3, 8, 30, 100].map((n) => <SignalPill key={n} active={t.mSignals[n]} label={`M${n}`} streak={t.mStreaks?.[n]?.streak} capped={t.mStreaks?.[n]?.capped} />).reduce((a, b) => [a, " ", b])}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {activeView !== "All" && (
                            <button onClick={() => removeFromWatchlist(activeView, s.ISIN)} title={`Remove from ${activeView}`}
                              style={{ padding: 4, borderRadius: 4, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, display: "inline-flex" }}>
                              <X size={11} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={18} style={{ background: T.surface, padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                              <div>
                                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8 }}>Fundamentals — {f?.latestFY || "—"}</div>
                                {f ? (
                                  <>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 10px", borderBottom: `1px solid ${T.border}`, marginBottom: 8 }}>
                                      <span style={{ fontSize: 11, color: T.textDim }}>Composite score:</span>
                                      <FundTierBadge fundScore={f.score} />
                                      {f.score?.exempt && <span style={{ fontSize: 10, color: T.textDim }}>* financial-sector weighting</span>}
                                    </div>
                                    <div style={{ display: "grid", gridTemplateColumns: "110px 70px 70px 70px 1fr", gap: 8, fontSize: 10, color: T.textDim, marginBottom: 4 }}>
                                      <span>Metric</span><span>3yr avg</span><span>Last yr</span><span>Var %</span><span>Signal</span>
                                    </div>
                                    <FundRow label="ROE" block={f.roe} />
                                    <FundRow label="ROCE" block={f.roce} />
                                    <FundRow label="EPS growth" block={f.epsGrowth} />
                                    <FundRow label="Sales growth" block={f.salesGrowth} />
                                    <FundRow label="Debt/Equity" block={f.debtEquity} isPercent={false} />
                                    <FundRow label="Asset turns" block={f.assetTurns} isPercent={false} />
                                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                                      <span style={{ color: T.textDim }}>CWIP % of Fixed Assets</span>
                                      <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(f.cwipPct)}%</span>
                                    </div>
                                  </>
                                ) : <div style={{ color: T.textDim, fontSize: 12 }}>No fundamentals data for this stock.</div>}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: T.gold, marginBottom: 8 }}>Technicals</div>
                                {t ? (
                                  <div style={{ fontSize: 12, lineHeight: 2 }}>
                                    <div>52w range: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>₹{fmtNum(t.low52, 2)} – ₹{fmtNum(t.high52, 2)}</b></div>
                                    <div>% from 52w high / low: <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.loss }}>{fmtPct(t.pctFromHigh52, 0)}</b> <span style={{ color: T.textDim }}>/</span> <b style={{ fontFamily: "'IBM Plex Mono', monospace", color: T.gain }}>{fmtPct(t.pctFromLow52, 0)}</b></div>
                                    <div>CMP / 52w low: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.cmpOverLow52, 2)}x</b></div>
                                    <div>Volume today / 30d avg: <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t.volToday?.toLocaleString("en-IN")} / {Math.round(t.vol30 || 0).toLocaleString("en-IN")}</b></div>
                                    <div>Moving averages: {[3, 8, 30, 50, 100, 200].map((n) => <span key={n} style={{ fontFamily: "'IBM Plex Mono', monospace", marginRight: 10 }}>MA{n}: {fmtNum(t.mas[n], 2)}</span>)}</div>
                                    <div>RSI (14): <b style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmtNum(t.rsi)}</b></div>
                                    <div>RS Rating (vs universe): <RSRatingBadge rsRating={t.rsRating} /></div>
                                  </div>
                                ) : <div style={{ color: T.textDim, fontSize: 12 }}>No price data for this stock.</div>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        </>
      )}
      </>
      )}

      {activeAssetClass === "equities" && equitiesSubTab === "breakout" && (
        <GoldenBreakoutScreen candidates={goldenBreakoutCandidates} accent={T.gold} hasFundamentals={true} itemLabel="Stock" />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "sectoral" && (
        <SectoralScreen computed={sectoralComputed} accent={T.gold} />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "sectoralBreakout" && (
        <GoldenBreakoutScreen candidates={sectoralBreakoutCandidates} accent={T.gold} hasFundamentals={false} itemLabel="Industry" />
      )}
      {activeAssetClass === "equities" && equitiesSubTab === "breadth" && (
        <MarketBreadthScreen series={breadthSeries} />
      )}

      {activeAssetClass === "commodities" && commoditiesSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.commodities} />}
      {activeAssetClass === "commodities" && commoditiesSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.commodities} />}

      {activeAssetClass === "indices" && indicesSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.indices} />}
      {activeAssetClass === "indices" && indicesSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.indices} />}

      {activeAssetClass === "crypto" && cryptoSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.crypto} />}
      {activeAssetClass === "crypto" && cryptoSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.crypto} />}

      {activeAssetClass === "currencies" && currenciesSubTab === "base" && <GenericAssetScreen config={ASSET_CLASSES.currencies} />}
      {activeAssetClass === "currencies" && currenciesSubTab === "breakout" && <GenericGoldenBreakoutScreen config={ASSET_CLASSES.currencies} />}
    </div>
  );
}
