import i18n from '@/i18n';
/**
 * Alpha Zoo — browse / detail / bench views.
 *
 * Routing model: a single page component, three URL shapes:
 *   /alpha-zoo                 → browse view
 *   /alpha-zoo/bench           → bench runner
 *   /alpha-zoo/:alphaId        → alpha detail
 *
 * The bench view uses a raw EventSource rather than the shared `useSSE` hook
 * because that hook hard-codes the agent's known event types (text_delta,
 * tool_call, …) and would silently drop the alpha bench events
 * (`progress`, `result`, `done`, `error`). The swarm page uses the same
 * raw-EventSource pattern (frontend/src/pages/Agent.tsx).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Layers,
  Search,
  Play,
  ArrowLeft,
  ArrowLeftRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Library,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  api,
  type AlphaSummary,
  type AlphaDetailResponse,
  type AlphaBenchResult,
  type AlphaBenchTopRow,
  type AlphaCompareResult,
} from "@/lib/api";
import { echarts } from "@/lib/echarts";
import { getChartTheme } from "@/lib/chart-theme";
import { useDarkMode } from "@/hooks/useDarkMode";

/* ---------- Constants ---------- */

interface ZooCard {
  id: string;
  title: string;
  description: string;
  approxCount: number;
  accent: string;
}

// IMPORTANT: The Kakushadze 101 zoo must use the author's name as the label.
// The legacy / trademark name is forbidden by a CI grep gate — do not add it.
const ZOO_CARDS: ZooCard[] = [
  {
    id: "qlib158",
    title: "Qlib 158",
    description:
      "Microsoft Qlib's full 158-feature library covering momentum, volatility, volume and rolling statistical signals.",
    approxCount: 154,
    accent: "from-sky-500/20 to-sky-500/5",
  },
  {
    id: "alpha101",
    title: "Kakushadze 101 Formulaic Alphas",
    description:
      "The 101 formulaic alphas from Kakushadze (2015); short-horizon cross-sectional signals.",
    approxCount: 101,
    accent: "from-emerald-500/20 to-emerald-500/5",
  },
  {
    id: "gtja191",
    title: "GTJA 191",
    description:
      "Guotai Junan Securities' 191 alphas; technical and microstructure signals tuned to China A-share markets.",
    approxCount: 191,
    accent: "from-amber-500/20 to-amber-500/5",
  },
  {
    id: "academic",
    title: "Academic Anomalies",
    description:
      "Curated long-horizon anomalies from the academic literature (value, momentum, quality, low-vol, etc.).",
    approxCount: 6,
    accent: "from-violet-500/20 to-violet-500/5",
  },
];

const UNIVERSE_OPTIONS = [
  { value: "csi300", labelKey: "alphaZoo.universeMap.csi300" },
  { value: "sp500", labelKey: "alphaZoo.universeMap.sp500" },
  { value: "btc-usdt", labelKey: "alphaZoo.universeMap.btc-usdt" },
];

/* ---------- Helpers ---------- */

function fmtNum(v: unknown, digits = 3): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function metaString(meta: Record<string, unknown>, key: string): string {
  const v = meta[key];
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function translateValue(mapKey: string, value: string): string {
  const translated = i18n.t(`${mapKey}.${value}`);
  return translated === `${mapKey}.${value}` ? value : translated;
}

function translateNotes(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bCarhart \(1997\) UMD momentum factor\./g, "Carhart（1997）UMD 动量因子。"],
    [/\bFama-French \(2015\) CMA \(Conservative Minus Aggressive\) investment factor\./g, "Fama-French（2015）CMA（保守减激进）投资因子。"],
    [/\bFama-French \(1993\) HML \(High Minus Low\) value factor\./g, "Fama-French（1993）HML（高减低）价值因子。"],
    [/\bSharpe \(1964\) \/ Fama-French market factor \(MKT-RF\)\./g, "Sharpe（1964）/ Fama-French 市场因子（MKT-RF）。"],
    [/\bFama-French \(2015\) RMW \(Robust Minus Weak\) profitability factor\./g, "Fama-French（2015）RMW（稳健减弱势）盈利能力因子。"],
    [/\bFama-French \(1993\) SMB \(Small Minus Big\) size factor\./g, "Fama-French（1993）SMB（小盘减大盘）规模因子。"],
    [/\bPRICE PROXY\b/g, "价格代理"],
    [/\bThe original definition uses total-asset growth from fundamental data;/g, "原始定义使用基本面数据中的总资产增长；"],
    [/\bhere we use the negative 60-day change in log average volume as an activity-growth proxy,/g, "这里我们用对数平均成交量 60 日变化的相反数作为活跃度增长代理，"],
    [/\bthen cross-sectional z-score per date for long-short ranking\./g, "然后按日期做横截面 z-score 以用于多空排序。"],
    [/\bTop z-scores = winners\./g, "z-score 越高表示赢家。"],
    [/\bConstructed directly from prices, so this matches the original definition modulo the z-score wrapper\./g, "该信号直接由价格构造，因此除 z-score 封装外与原始定义一致。"],
    [/\bCanonical 252d window; declared decay_horizon=60 due to registry schema cap \(le=60\); real signal horizon=252\./g, "标准窗口为 252 天；由于注册表 schema 上限（le=60），声明的 decay_horizon=60；真实信号周期为 252。"],
    [/\bThe original definition uses book-to-market ratio from fundamental data;/g, "原始定义使用基本面数据中的账面市值比；"],
    [/\bhere we use the negative 252-day total return as a long-term reversal proxy,/g, "这里我们用 252 日总收益的相反数作为长期反转代理，"],
    [/\bTop z-scores = long-term underperformers \(deeper value\)\./g, "z-score 越高表示长期表现较差的标的（更偏价值）。"],
    [/\bThe original definition uses value-weighted market excess returns;/g, "原始定义使用市值加权市场超额收益；"],
    [/\bhere we use a 21-day per-stock total return and cross-sectional z-score per date for long-short ranking\./g, "这里我们使用 21 日个股总收益，并按日期做横截面 z-score 以用于多空排序。"],
    [/\bTop z-scores = strong recent winners; bottom = losers\./g, "z-score 越高表示近期强势赢家；最低值对应输家。"],
    [/\bThe original definition uses operating profitability from fundamental data;/g, "原始定义使用基本面数据中的经营盈利能力；"],
    [/\bhere we use the negative of 60-day return volatility as a low-vol-quality proxy,/g, "这里我们使用 60 日收益波动率的相反数作为低波动质量代理，"],
    [/\bTop z-scores = lower vol \(quality \/ robust\)\./g, "z-score 越高表示更低波动（质量/稳健）。"],
    [/\bThe original definition uses market capitalization from book equity data;/g, "原始定义使用账面权益数据中的市值；"],
    [/\bhere we use the negative log of 60-day average dollar volume \(close \* volume\) as a liquidity-weighted size proxy,/g, "这里我们使用 60 日平均成交额（收盘价 × 成交量）对数的相反数作为流动性加权规模代理，"],
    [/\bTop z-scores = smaller \/ less liquid names\./g, "z-score 越高表示更小盘 / 更不流动的标的。"],
    [/\[PRICE PROXY\] for the /g, "【价格代理】对应 "],
    [/\bVery long lookback \(>= ~100 bars\); produces NaN warmup on short panels which may trigger the >95% NaN registry guard\./g, "极长回看期（>= 约 100 根 K 线）；在短面板上会产生 NaN 预热，可能触发 >95% NaN 注册表保护。"],
    [/\bIndustry neutralization implemented via per-row sector group demean \(panel\['sector'\] required\)\. When sector tag is absent the registry rejects via SkipAlpha; the compute\(\) also has a degraded global demean fallback\./g, "行业中性化通过按行 sector 分组去均值实现（需要 panel['sector']）。当缺少 sector 标签时，注册表会通过 SkipAlpha 拒绝；compute() 里也有一个降级的全局去均值回退。"],
    [/\bThis is a partial approximation of the paper's IndClass\.industry\/subindustry\/sector neutralization\./g, "这是对论文中 IndClass 的 industry/subindustry/sector 中性化的近似实现。"],
    [/\bPaper formula uses market 'cap' which is not part of the standard OHLCV panel; substituted by a constant 1\.0 DataFrame\. Result remains a valid factor but loses the cap-weighting term\./g, "论文公式使用了市场 'cap'，而这不属于标准 OHLCV 面板；这里用常数 1.0 的 DataFrame 替代。结果仍是有效因子，但丢失了 cap 加权项。"],
    [/\bthe registry rejects via SkipAlpha/g, "注册表会通过 SkipAlpha 拒绝"],
    [/\bcompute\(\) also has a degraded global demean fallback\./g, "compute() 里也有一个降级的全局去均值回退。"],
  ];
  let out = text;
  for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);
  return out;
}

function translateNotesByKey(t: (key: string, opts?: Record<string, unknown>) => string, notesKey?: string | null, notesText?: string): string {
  if (notesKey) {
    const translated = t(`alphaZoo.notesMap.${notesKey}`);
    if (translated !== `alphaZoo.notesMap.${notesKey}`) return translated;
  }
  return notesText || "—";
}

/* ---------- Page entry ---------- */

export function AlphaZoo() {
  const params = useParams<{ alphaId?: string }>();
  const { pathname } = useLocation();

  // Internal view selection
  if (pathname === "/alpha-zoo/bench") {
    return <BenchView />;
  }
  if (pathname === "/alpha-zoo/compare") {
    return <CompareView />;
  }
  if (params.alphaId) {
    return <DetailView alphaId={params.alphaId} />;
  }
  return <BrowseView />;
}

/* ---------- Browse view ---------- */

function BrowseView() {
  const { t } = useTranslation();
  const { state } = useLocation();
  const navigate = useNavigate();
  const [alphas, setAlphas] = useState<AlphaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [zooFilter, setZooFilter] = useState<string>("");
  const [themeFilter, setThemeFilter] = useState<string>("");
  const [universeFilter, setUniverseFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [total, setTotal] = useState<number>(0);
  // Alphas ticked for a head-to-head compare; handed to CompareView via the URL.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const compareHref =
    selected.size >= 2
      ? `/alpha-zoo/compare?ids=${[...selected].map(encodeURIComponent).join(",")}`
      : "/alpha-zoo/compare";

  const pageSize = 20;
  const initialPage = typeof state?.browsePage === "number" ? state.browsePage : 1;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listAlphas({
        zoo: zooFilter || undefined,
        theme: themeFilter || undefined,
        universe: universeFilter || undefined,
        limit: 1000,
      })
      .then((res) => {
        if (!alive) return;
        setAlphas(res.alphas);
        setTotal(res.total);
        setPage(initialPage);
        setJumpInput(String(initialPage));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : "Failed to load alphas";
        toast.error(msg);
        setAlphas([]);
        setTotal(0);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [zooFilter, themeFilter, universeFilter, initialPage]);

  const themeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of alphas) for (const t of a.theme || []) set.add(t);
    return Array.from(set).sort();
  }, [alphas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return alphas;
    return alphas.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        (a.nickname || "").toLowerCase().includes(q),
    );
  }, [alphas, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const goToPage = (nextPage: number) => {
    const clamped = Math.min(Math.max(nextPage, 1), totalPages);
    setPage(clamped);
    setJumpInput(String(clamped));
  };

  const pageNumbers = useMemo(() => {
    const pages: Array<number | "..."> = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i += 1) pages.push(i);
      return pages;
    }
    pages.push(1);
    const left = Math.max(2, safePage - 1);
    const right = Math.min(totalPages - 1, safePage + 1);
    if (left > 2) pages.push("...");
    for (let i = left; i <= right; i += 1) pages.push(i);
    if (right < totalPages - 1) pages.push("...");
    pages.push(totalPages);
    return pages;
  }, [safePage, totalPages]);

  const openDetail = (alphaId: string) => {
    navigate(`/alpha-zoo/${encodeURIComponent(alphaId)}`, {
      state: {
        fromBrowse: true,
        browsePage: safePage,
      },
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8">
      {/* Hero */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.title")}
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          {total > 0 ? total : 452} {t("alphaZoo.prebuiltAlpha", { count: total > 0 ? total : 452 })}
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {t("alphaZoo.browseDesc")}
        </p>
      </div>

      {/* Zoo cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {ZOO_CARDS.map((z) => {
          const active = zooFilter === z.id;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => setZooFilter(active ? "" : z.id)}
              className={cn(
                "text-left border rounded-xl p-4 space-y-2 transition bg-gradient-to-br",
                z.accent,
                "hover:border-primary/50",
                active && "border-primary ring-1 ring-primary/30",
              )}
            >
              <div className="flex items-center justify-between">
                <Library className="h-5 w-5 text-primary" aria-hidden="true" />
                <span className="text-xs font-mono text-muted-foreground">
                  {z.approxCount}
                </span>
              </div>
              <h3 className="font-semibold text-sm leading-tight">{z.title}</h3>
              <p className="text-xs text-muted-foreground line-clamp-3">
                {z.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-col md:flex-row md:items-end gap-3 border rounded-xl p-4 bg-card">
        <div className="flex-1 min-w-0">
          <label htmlFor="alpha-search" className="text-xs text-muted-foreground block mb-1">
            {t("alphaZoo.search")}
          </label>
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="alpha-search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                setJumpInput("1");
              }}
              placeholder={t("alphaZoo.searchPlaceholder")}
              className="w-full pl-9 pr-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
        <div className="md:w-40">
          <label htmlFor="alpha-zoo-filter" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.zoo")}</label>
          <select
            id="alpha-zoo-filter"
            value={zooFilter}
            onChange={(e) => {
              setZooFilter(e.target.value);
              setPage(1);
              setJumpInput("1");
            }}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">{t("alphaZoo.allZoos")}</option>
            {ZOO_CARDS.map((z) => (
              <option key={z.id} value={z.id}>
                {z.title}
              </option>
            ))}
          </select>
        </div>
        <div className="md:w-40">
          <label htmlFor="alpha-theme-filter" className="text-xs text-muted-foreground block mb-1">
            {t("alphaZoo.theme")}
          </label>
          <select
            id="alpha-theme-filter"
            value={themeFilter}
            onChange={(e) => {
              setThemeFilter(e.target.value);
              setPage(1);
              setJumpInput("1");
            }}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">{t("alphaZoo.allThemes")}</option>
            {themeOptions.map((tname) => (
              <option key={tname} value={tname}>
                {translateValue("alphaZoo.themeMap", tname)}
              </option>
            ))}
          </select>
        </div>
        <div className="md:w-44">
          <label htmlFor="alpha-universe-filter" className="text-xs text-muted-foreground block mb-1">
            {t("alphaZoo.universe")}
          </label>
          <select
            id="alpha-universe-filter"
            value={universeFilter}
            onChange={(e) => {
              setUniverseFilter(e.target.value);
              setPage(1);
              setJumpInput("1");
            }}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">{t("alphaZoo.allUniverses")}</option>
            {UNIVERSE_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>
                {t(u.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <Link
          to={compareHref}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted hover:text-foreground transition"
          title={t("alphaZoo.pickAtLeast2")}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.compare")}
          {selected.size >= 2 ? ` (${selected.size})` : ""}
        </Link>
        <Link
          to="/alpha-zoo/bench"
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.runBenchmark")}
        </Link>
      </div>

      {/* Table */}
      {/* TODO(v0.2): switch to react-window if alpha count exceeds 5000 */}
      <div className="border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Alpha catalogue">
            <caption className="sr-only">Alpha catalogue</caption>
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="w-10 px-3 py-2.5">
                  <span className="sr-only">Select for compare</span>
                </th>
                <th className="text-left px-4 py-2.5 text-muted-foreground">
                  ID
                </th>
                <th className="text-left px-4 py-2.5 text-muted-foreground">
                  {t("alphaZoo.zoo")}
                </th>
                <th className="text-left px-4 py-2.5 text-muted-foreground">
                  {t("alphaZoo.theme")}
                </th>
                <th className="text-left px-4 py-2.5 text-muted-foreground hidden md:table-cell">
                  {t("alphaZoo.universe")}
                </th>
                <th className="text-right px-4 py-2.5 text-muted-foreground" title="Predictive half-life: trading days before the signal's edge decays">
                  {t("alphaZoo.decayDays")}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" aria-hidden="true" />
                    {t("alphaZoo.loadingAlphas")}
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t("alphaZoo.noAlphasMatch")}
                  </td>
                </tr>
              ) : (
                visible.map((a) => (
                  <tr
                    key={`${a.zoo}:${a.id}`}
                    className={cn(
                      "border-b last:border-0 hover:bg-muted/20",
                      selected.has(a.id) && "bg-primary/5",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        aria-label={`Select ${a.id} for compare`}
                        className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      <button
                        type="button"
                        onClick={() => openDetail(a.id)}
                        className="text-primary hover:underline text-left"
                      >
                        {a.id}
                      </button>
                      {a.nickname && (
                        <span className="ml-2 text-muted-foreground font-sans">
                          {a.nickname}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">{a.zoo}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {(a.theme || []).map((v) => translateValue("alphaZoo.themeMap", v)).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground hidden md:table-cell">
                      {(a.universe || []).map((v) => translateValue("alphaZoo.universeMap", v)).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">
                      {a.decay_horizon ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div className="border-t p-3 flex flex-col gap-3 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <span>
                {t("alphaZoo.showingOf", { visible: visible.length, total: filtered.length })}
              </span>
              <span className="font-mono tabular-nums">
                {safePage} / {totalPages}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => goToPage(safePage - 1)}
                disabled={safePage <= 1}
                className="px-3 py-1 rounded-md border hover:bg-muted hover:text-foreground transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("pagination.previous", { defaultValue: "Prev" })}
              </button>
              {pageNumbers.map((item, idx) =>
                item === "..." ? (
                  <span key={`dots-${idx}`} className="px-2">
                    ...
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => goToPage(item)}
                    className={cn(
                      "min-w-9 px-3 py-1 rounded-md border transition",
                      item === safePage
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => goToPage(safePage + 1)}
                disabled={safePage >= totalPages}
                className="px-3 py-1 rounded-md border hover:bg-muted hover:text-foreground transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("pagination.next", { defaultValue: "Next" })}
              </button>
              <div className="ml-auto flex items-center gap-2">
                <span>{t("pagination.jump", { defaultValue: "Jump to" })}</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const next = Number(jumpInput);
                      if (Number.isFinite(next)) goToPage(next);
                    }
                  }}
                  className="w-20 px-2 py-1 rounded-md border bg-background text-xs text-center"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = Number(jumpInput);
                    if (Number.isFinite(next)) goToPage(next);
                  }}
                  className="px-3 py-1 rounded-md border hover:bg-muted hover:text-foreground transition"
                >
                  {t("pagination.go", { defaultValue: "Go" })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Detail view ---------- */

interface DetailProps {
  alphaId: string;
}

function DetailView({ alphaId }: DetailProps) {
  const { t } = useTranslation();
  const { state } = useLocation();
  const [detail, setDetail] = useState<AlphaDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const browsePage = typeof state?.browsePage === "number" ? state.browsePage : 1;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getAlpha(alphaId)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : "Failed to load alpha";
        setError(msg);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [alphaId]);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" /> {t("alphaZoo.loadingAlpha", { alphaId })}
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-8 max-w-3xl mx-auto space-y-4">
        <Link
          to="/alpha-zoo"
          state={{ fromBrowse: true, browsePage }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.backToAlphaZoo")}
        </Link>
        <div className="border rounded-xl p-6 bg-card">
          <h2 className="font-semibold text-sm mb-1 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" /> {t("alphaZoo.couldNotLoad")}
          </h2>
          <p className="text-sm text-muted-foreground">{error || t("alphaZoo.unknownError")}</p>
        </div>
      </div>
    );
  }

  const a = detail.alpha;
  const meta = a.meta || {};
  const formulaLatex = (meta["formula_latex"] as string | undefined) || "";
  const nickname = (meta["nickname"] as string | undefined) || "";
  const firstUniverse = ((meta["universe"] as string[] | undefined) || [])[0] || "";
  const notesValue = translateNotesByKey(t, a.notes_key, translateNotes(metaString(meta, "notes")));

  // Keep period in sync with the BenchView form default so the prefilled
  // form values match what users see if they click "Run bench" from here.
  const benchHref = firstUniverse
    ? `/alpha-zoo/bench?zoo=${encodeURIComponent(a.zoo)}&universe=${encodeURIComponent(firstUniverse)}&period=2020-2025`
    : `/alpha-zoo/bench?zoo=${encodeURIComponent(a.zoo)}&period=2020-2025`;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link
          to="/alpha-zoo"
          state={{ fromBrowse: true, browsePage }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.backToAlphaZoo")}
        </Link>
        <button
          type="button"
          onClick={() => navigate(benchHref)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.runBenchmark")}
        </button>
      </div>

      {/* Title */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="font-mono text-xl md:text-2xl font-bold tracking-tight">
            {a.id}
          </h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
            {a.zoo}
          </span>
        </div>
        {nickname && (
          <p className="text-sm text-muted-foreground">{nickname}</p>
        )}
      </div>

      {/* Formula */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{i18n.t("alphaZoo.formula")}</h2>
        <pre className="border rounded-xl bg-muted/30 p-4 overflow-x-auto text-xs leading-relaxed">
          <code>{formulaLatex || "(no formula provided)"}</code>
        </pre>
      </section>

      {/* Metadata */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{i18n.t("alphaZoo.metadata")}</h2>
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <MetaRow label={t("alphaZoo.themeValues")} value={metaString(meta, "theme").split(", ").map((v) => translateValue("alphaZoo.themeMap", v)).join(", ")} />
              <MetaRow label={t("alphaZoo.universe")} value={metaString(meta, "universe").split(", ").map((v) => translateValue("alphaZoo.universeMap", v)).join(", ")} />
              <MetaRow label={t("alphaZoo.frequency")} value={metaString(meta, "frequency")} />
              <MetaRow label={t("alphaZoo.decayHorizon")} value={metaString(meta, "decay_horizon")} />
              <MetaRow label={t("alphaZoo.minWarmupBars")} value={metaString(meta, "min_warmup_bars")} />
              <MetaRow label={t("alphaZoo.requiresSector")} value={metaString(meta, "requires_sector")} />
              <MetaRow label={t("alphaZoo.modulePath")} value={a.module_path || "—"} />
              <MetaRow label={t("alphaZoo.notes")} value={notesValue} last />
            </tbody>
          </table>
        </div>
      </section>

      {/* Source code */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{i18n.t("alphaZoo.sourceCode")}</h2>
        <details className="border rounded-xl bg-card group">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-muted/40 select-none">
            {t("alphaZoo.viewSource", { lines: (detail.source_code || "").split("\n").length })}
          </summary>
          <pre className="border-t bg-muted/30 p-4 overflow-x-auto text-xs leading-relaxed">
            <code>{detail.source_code || "(no source available)"}</code>
          </pre>
        </details>
      </section>
    </div>
  );
}

function MetaRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <tr className={cn(!last && "border-b", "hover:bg-muted/20")}>
      <td className="px-4 py-2 text-xs text-muted-foreground w-1/3">{label}</td>
      <td className="px-4 py-2 text-xs font-mono break-all">{value}</td>
    </tr>
  );
}

/* ---------- Bench view ---------- */

type BenchStatus = "idle" | "submitting" | "streaming" | "done" | "error";

interface BenchProgress {
  n_done: number;
  n_total: number;
  current_alpha_id?: string;
}

function BenchView() {
  const { t } = useTranslation();
  // Read prefill from query string (set by Detail "Run bench" button).
  const { search: locSearch } = useLocation();
  const initial = useMemo(() => {
    const q = new URLSearchParams(locSearch);
    return {
      zoo: q.get("zoo") || "alpha101",
      universe: q.get("universe") || "csi300",
      period: q.get("period") || "2020-2025",
      top: Number(q.get("top") || "20"),
    };
  }, [locSearch]);

  const [zoo, setZoo] = useState(initial.zoo);
  const [universe, setUniverse] = useState(initial.universe);
  const [period, setPeriod] = useState(initial.period);
  const [top, setTop] = useState<number>(initial.top);

  const [status, setStatus] = useState<BenchStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [result, setResult] = useState<AlphaBenchResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Track terminal `done` so the synthetic EventSource `error` fired on
  // close doesn't surface as a spurious toast (race between done + error).
  const doneRef = useRef(false);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  const startBench = async (e: FormEvent) => {
    e.preventDefault();
    if (status === "submitting" || status === "streaming") return;
    setStatus("submitting");
    setProgress(null);
    setResult(null);
    setFormError(null);
    doneRef.current = false;
    sourceRef.current?.close();
    const safeTop = Number.isFinite(top) && top > 0 ? top : 20;
    try {
      const res = await api.createAlphaBench({
        zoo,
        universe,
        period,
        top: safeTop,
      });
      setJobId(res.job_id);
      attachStream(res.job_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start bench";
      // BTC-USDT is single-asset — surface inline rather than as a toast,
      // because the form is the action context and the message includes a
      // concrete suggestion for the user's next step.
      if (msg.toLowerCase().includes("single-asset")) {
        setFormError(
          `${msg} Try \`sp500\` or \`csi300\` for a meaningful cross-sectional IC.`,
        );
      } else {
        toast.error(msg);
      }
      setStatus("error");
    }
  };

  const attachStream = (newJobId: string) => {
    setStatus("streaming");
    const url = api.alphaBenchStreamUrl(newJobId);
    const source = new EventSource(url);
    sourceRef.current = source;

    source.addEventListener("progress", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as BenchProgress;
        setProgress(data);
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("result", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as AlphaBenchResult;
        setResult(data);
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("done", () => {
      doneRef.current = true;
      setStatus("done");
      source.close();
      sourceRef.current = null;
    });

    source.addEventListener("error", (e) => {
      // EventSource raises a synthetic error on every disconnect, including
      // the normal close that follows our `done` event. The ref check is
      // synchronous (state updates from `done` would be batched and not
      // visible here yet), so it's the only reliable race guard.
      if (doneRef.current) {
        source.close();
        sourceRef.current = null;
        return;
      }
      let msg = "Bench stream error";
      try {
        const data = JSON.parse((e as MessageEvent).data || "{}");
        if (typeof data.message === "string") msg = data.message;
      } catch {
        /* network-level error, no payload */
      }
      toast.error(msg);
      setStatus("error");
      source.close();
      sourceRef.current = null;
    });
  };

  const busy = status === "submitting" || status === "streaming";

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <Link
        to="/alpha-zoo"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.backToAlphaZoo")}
      </Link>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.benchRunner")}
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          {t("alphaZoo.benchmarkTitle")}
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {t("alphaZoo.benchmarkDesc")}
        </p>
      </div>

      {/* Form */}
      <form
        onSubmit={startBench}
        className="border rounded-xl p-4 bg-card grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
      >
        <div>
          <label htmlFor="bench-zoo" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.zoo")}</label>
          <select
            id="bench-zoo"
            value={zoo}
            onChange={(e) => setZoo(e.target.value)}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          >
            {ZOO_CARDS.map((z) => (
              <option key={z.id} value={z.id}>
                {z.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-universe" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.universe")}</label>
          <select
            id="bench-universe"
            value={universe}
            onChange={(e) => setUniverse(e.target.value)}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          >
            {UNIVERSE_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>
                {t(u.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bench-period" className="text-xs text-muted-foreground block mb-1">{i18n.t("alphaZoo.period")}</label>
          <input
            id="bench-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            disabled={busy}
            placeholder="2020-2025"
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          />
        </div>
        <div>
          <label htmlFor="bench-top" className="text-xs text-muted-foreground block mb-1">{i18n.t("alphaZoo.top")}</label>
          <input
            id="bench-top"
            type="number"
            min={1}
            max={500}
            value={Number.isFinite(top) ? top : ""}
            onChange={(e) =>
              // Empty input → fall back to default; submit also clamps
              // to a safe value so NaN never reaches the API.
              setTop(e.target.value === "" ? 20 : Number(e.target.value))
            }
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {t("alphaZoo.running")}
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.runBenchmark")}
              </>
            )}
          </button>
        </div>
        {formError && (
          <p
            className="sm:col-span-2 lg:col-span-5 text-xs text-red-600 dark:text-red-400"
            role="alert"
          >
            {formError}
          </p>
        )}
      </form>

      {/* Progress */}
      {(status === "submitting" || status === "streaming") && (
        <ProgressPanel jobId={jobId} progress={progress} />
      )}

      {/* Result */}
      {result && <ResultPanel result={result} />}
    </div>
  );
}

function ProgressPanel({
  jobId,
  progress,
}: {
  jobId: string | null;
  progress: BenchProgress | null;
}) {
  const pct = progress && progress.n_total > 0
    ? Math.min(100, Math.round((progress.n_done / progress.n_total) * 100))
    : 0;
  return (
    <div className="border rounded-xl p-4 bg-card space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {jobId ? `Job ${jobId.slice(0, 12)}…` : "Submitting…"}
        </span>
        {progress && (
          <span className="font-mono tabular-nums">
            {progress.n_done} / {progress.n_total}
          </span>
        )}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress?.current_alpha_id && (
        <p className="text-xs text-muted-foreground font-mono truncate">
          Computing: {progress.current_alpha_id}
        </p>
      )}
    </div>
  );
}

function ResultPanel({ result }: { result: AlphaBenchResult }) {
  const { t } = useTranslation();
  const { dark } = useDarkMode();
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    const theme = getChartTheme();
    const chart = echarts.init(chartRef.current);
    const themes = Object.keys(result.by_theme || {}).sort();
    const aliveSeries = themes.map((k) => result.by_theme[k].alive);
    const reversedSeries = themes.map((k) => result.by_theme[k].reversed);
    const deadSeries = themes.map((k) => result.by_theme[k].dead);

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        data: [t("alphaZoo.alive"), t("alphaZoo.reversed"), t("alphaZoo.dead")],
        textStyle: { color: theme.textColor, fontSize: 11 },
        right: 8,
        top: 4,
      },
      grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: themes,
        axisLine: { lineStyle: { color: theme.axisColor } },
        axisLabel: { color: theme.textColor, fontSize: 10, rotate: themes.length > 6 ? 30 : 0 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: theme.gridColor } },
        axisLabel: { color: theme.textColor, fontSize: 10 },
      },
      series: [
        { name: t("alphaZoo.alive"), type: "bar", stack: "n", data: aliveSeries, itemStyle: { color: theme.upColor } },
        { name: t("alphaZoo.reversed"), type: "bar", stack: "n", data: reversedSeries, itemStyle: { color: theme.warningColor } },
        { name: t("alphaZoo.dead"), type: "bar", stack: "n", data: deadSeries, itemStyle: { color: theme.downColor } },
      ],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [result, dark]);

  const totals = [
    { label: t("alphaZoo.alive"), value: result.alive, icon: CheckCircle2, tone: "text-green-600 dark:text-green-400" },
    { label: t("alphaZoo.reversed"), value: result.reversed, icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400" },
    { label: t("alphaZoo.dead"), value: result.dead, icon: XCircle, tone: "text-red-600 dark:text-red-400" },
    { label: t("alphaZoo.skipped"), value: result.skipped ?? 0, icon: Loader2, tone: "text-muted-foreground" },
  ];

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {totals.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="border rounded-xl p-4 bg-card flex items-center gap-3">
            <Icon className={cn("h-5 w-5 shrink-0", tone)} aria-hidden="true" />
            <div>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-bold tabular-nums">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Top tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopTable title={t("alphaZoo.topByIr")} rows={result.top5_by_ir || []} />
        <TopTable title={t("alphaZoo.mostReversed")} rows={(result.dead_examples || []).slice(0, 3)} />
      </div>

      {/* By-theme breakdown */}
      {result.by_theme && Object.keys(result.by_theme).length > 0 && (
        <div className="border rounded-xl p-4 bg-card">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            {t("alphaZoo.byTheme")}
          </h3>
          <div ref={chartRef} style={{ height: 240 }} />
        </div>
      )}
    </div>
  );
}

function TopTable({ title, rows }: { title: string; rows: AlphaBenchTopRow[] }) {
  const { t } = useTranslation();
  return (
    <div className="border rounded-xl overflow-hidden bg-card">
      <div className="px-4 py-2.5 border-b bg-muted/40">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground text-center">
          {t("alphaZoo.noRows")}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">ID</th>
              <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">{t("alphaZoo.meanIc")}</th>
              <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">IR</th>
              <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">{t("alphaZoo.themeKey")}</th>
              <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">{t("alphaZoo.category")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20">
                <td className="px-4 py-2">
                  <Link
                    to={`/alpha-zoo/${encodeURIComponent(r.id)}`}
                    className="text-primary hover:underline font-mono text-xs"
                  >
                    {r.id}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">{fmtNum(r.ic_mean)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">{fmtNum(r.ir)}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{(r.theme || []).map((v) => translateValue("alphaZoo.themeMap", v)).join(", ") || "—"}</td>
                <td className="px-4 py-2 text-xs">
                  <CategoryBadge category={r.category} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Render the alpha bench category as a colored badge so users can see whether
 * a row is alive / reversed / dead at a glance. The "Most reversed" panel
 * mixes reversed + dead rows; the badge keeps them distinguishable.
 */
function CategoryBadge({ category }: { category: AlphaBenchTopRow["category"] }) {
  const { t } = useTranslation();
  const tone =
    category === "alive"
      ? "bg-green-500/10 text-green-700 dark:text-green-300"
      : category === "reversed"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "bg-red-500/10 text-red-700 dark:text-red-300";
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-full text-[10px] font-medium", tone)}>
      {category === "alive" ? t("alphaZoo.alive") : category === "reversed" ? t("alphaZoo.reversed") : t("alphaZoo.dead")}
    </span>
  );
}

/* ---------- Compare view ---------- */

const SORT_OPTIONS = [
  { value: "ir", label: "IR (information ratio)" },
  { value: "ic_mean", label: "IC mean" },
  { value: "ic_positive_ratio", label: "IC > 0 ratio" },
  { value: "ic_count", label: "Sample count" },
];

/** Split a free-text id list on commas / whitespace; dedupe, preserve order. */
function parseAlphaIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Head-to-head comparison of a hand-picked set of alphas.
 *
 * Mirrors {@link BenchView}'s raw-EventSource lifecycle (the shared `useSSE`
 * hook drops these event types). Ids are prefilled from `?ids=a,b,c` — set by
 * the BrowseView multi-select — and remain editable as free text.
 */
function CompareView() {
  const { t } = useTranslation();
  const { search: locSearch } = useLocation();
  const initialIds = useMemo(() => {
    const q = new URLSearchParams(locSearch);
    return parseAlphaIds(q.get("ids") || "").join(", ");
  }, [locSearch]);

  const [idsText, setIdsText] = useState(initialIds);
  const [universe, setUniverse] = useState("csi300");
  const [period, setPeriod] = useState("2020-2025");
  const [sort, setSort] = useState("ir");

  const [status, setStatus] = useState<BenchStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [result, setResult] = useState<AlphaCompareResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  const ids = useMemo(() => parseAlphaIds(idsText), [idsText]);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  const attachStream = (newJobId: string) => {
    setStatus("streaming");
    const source = new EventSource(api.alphaCompareStreamUrl(newJobId));
    sourceRef.current = source;

    source.addEventListener("progress", (e) => {
      try {
        setProgress(JSON.parse((e as MessageEvent).data) as BenchProgress);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("result", (e) => {
      try {
        setResult(JSON.parse((e as MessageEvent).data) as AlphaCompareResult);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("done", () => {
      doneRef.current = true;
      setStatus("done");
      source.close();
      sourceRef.current = null;
    });
    source.addEventListener("error", (e) => {
      // EventSource raises a synthetic error on the close that follows `done`;
      // the ref check (synchronous) is the only reliable race guard.
      if (doneRef.current) {
        source.close();
        sourceRef.current = null;
        return;
      }
      let msg = "Compare stream error";
      try {
        const data = JSON.parse((e as MessageEvent).data || "{}");
        if (typeof data.message === "string") msg = data.message;
      } catch {
        /* network-level error, no payload */
      }
      toast.error(msg);
      setStatus("error");
      source.close();
      sourceRef.current = null;
    });
  };

  const startCompare = async (e: FormEvent) => {
    e.preventDefault();
    if (status === "submitting" || status === "streaming") return;
    if (ids.length < 2) {
      setFormError("Enter at least 2 distinct alpha ids to compare.");
      return;
    }
    setStatus("submitting");
    setProgress(null);
    setResult(null);
    setFormError(null);
    doneRef.current = false;
    sourceRef.current?.close();
    try {
      const res = await api.createAlphaCompare({
        alpha_ids: ids,
        universe,
        period,
        sort,
      });
      setJobId(res.job_id);
      attachStream(res.job_id);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to start comparison";
      toast.error(msg);
      setStatus("error");
    }
  };

  const busy = status === "submitting" || status === "streaming";

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <Link
        to="/alpha-zoo"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.backToAlphaZoo")}
      </Link>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.headToHeadCompare")}
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          {t("alphaZoo.compareTitle")}
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {t("alphaZoo.compareDesc")}
        </p>
      </div>

      <form onSubmit={startCompare} className="border rounded-xl p-4 bg-card space-y-3">
        <div>
            <label htmlFor="compare-ids" className="text-xs text-muted-foreground block mb-1">
            {t("alphaZoo.alphaIds")}{ids.length > 0 ? ` (${t("alphaZoo.selectedCount", { count: ids.length })})` : ""}
          </label>
          <textarea
            id="compare-ids"
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="alpha101_1, alpha101_2, gtja191_5"
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            {t("alphaZoo.alphaIdsHint")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="compare-universe" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.universe")}</label>
            <select
              id="compare-universe"
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            >
              {UNIVERSE_OPTIONS.map((u) => (
                <option key={u.value} value={u.value}>
                  {t(u.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="compare-period" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.period")}</label>
            <input
              id="compare-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={busy}
              placeholder="2020-2025"
              className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="compare-sort" className="text-xs text-muted-foreground block mb-1">{t("alphaZoo.rankBy")}</label>
            <select
              id="compare-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || ids.length < 2}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Running…
              </>
            ) : (
              <>
                <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" /> {t("alphaZoo.compare")}
              </>
            )}
          </button>
          {ids.length < 2 && (
            <span className="text-xs text-muted-foreground">{t("alphaZoo.pickAtLeast2")}</span>
          )}
        </div>

        {formError && (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {formError}
          </p>
        )}
      </form>

      {(status === "submitting" || status === "streaming") && (
        <ProgressPanel jobId={jobId} progress={progress} />
      )}

      {result && <CompareResultPanel result={result} />}
    </div>
  );
}

function CompareResultPanel({ result }: { result: AlphaCompareResult }) {
  const { t } = useTranslation();
  const deltaKey = `delta_${result.sort}_vs_best`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {t("alphaZoo.winner")}:{" "}
          <span className="font-mono">{result.winner}</span>
        </span>
        <span className="text-muted-foreground">
          {result.n_compared} {t("alphaZoo.compared")} · {t("alphaZoo.rankedBy")} {result.sort} · {result.universe} · {result.period}
        </span>
        {result.n_skipped > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {result.n_skipped} {t("alphaZoo.skipped")}
          </span>
        )}
      </div>

      <div className="border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Alpha comparison ranking">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground text-xs">
                <th className="text-right px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Alpha</th>
                <th className="text-left px-3 py-2 hidden sm:table-cell">{t("alphaZoo.zoo")}</th>
                <th className="text-right px-3 py-2">{t("alphaZoo.icMean")}</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">{t("alphaZoo.icStd")}</th>
                <th className="text-right px-3 py-2">IR</th>
                <th className="text-right px-3 py-2 hidden md:table-cell" title={t("alphaZoo.icPositiveTitle")}>IC&gt;0</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell" title={t("alphaZoo.sampleCountTitle")}>{t("alphaZoo.sampleCount")}</th>
                <th className="text-right px-3 py-2" title={`Gap to the leader on ${result.sort}`}>Δ {result.sort}</th>
              </tr>
            </thead>
            <tbody>
              {result.ranking.map((r) => (
                <tr
                  key={`${r.zoo}:${r.id}`}
                  className={cn(
                    "border-b last:border-0 hover:bg-muted/20",
                    r.rank === 1 && "bg-emerald-500/5",
                  )}
                >
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.rank}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      to={`/alpha-zoo/${encodeURIComponent(r.id)}`}
                      className="text-primary hover:underline"
                    >
                      {r.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground hidden sm:table-cell">{r.zoo}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtNum(r.ic_mean, 4)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden md:table-cell">{fmtNum(r.ic_std, 4)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmtNum(r.ir, 3)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden md:table-cell">{fmtNum(r.ic_positive_ratio, 3)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums hidden lg:table-cell">{r.ic_count}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {r.rank === 1 ? "—" : fmtNum(Number(r[deltaKey]), 4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {result.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{t("alphaZoo.skipped")}:</span>{" "}
          {result.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}
        </p>
      )}
    </div>
  );
}
