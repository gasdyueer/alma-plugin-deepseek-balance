import type { PluginContext, PluginActivation } from 'alma-plugin-api';

/**
 * DeepSeek Balance
 *
 * 状态栏显示 DeepSeek 账户余额 + 今日已用，点击弹出明细。
 *
 * 设计要点（借鉴余额挂件类插件的经验）：
 *  - 只报事实：接口给不到的分项（赠金/充值）显示 "—"，绝不臆造 0。
 *  - 网络/5xx 重试一次，超时 8s；失败保留上一次成功值，只在 tooltip 标注"已过期"。
 *  - 今日已用按"余额差"记账（北京时间按天切分），持久化到 storage，进程重启不丢。
 *  - 余额上涨视为充值，不计入消耗，只把基线抬高。
 */

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const USAGE_PAGE = 'https://platform.deepseek.com/usage';

/** 峰时（北京时间，工作日）：09:00–12:00、14:00–18:00，其余时段为谷时（标准价 5 折）。 */
const PEAK_HOURS: Array<[number, number]> = [
  [9, 12],
  [14, 18],
];

/** 法定节假日全天谷时（只需列放假日）。每年国务院公布次年安排后在这里补充。 */
const HOLIDAY_VALLEY: Record<string, 1> = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
};

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 默认的密钥文件路径。settings.get 不会自动吃 manifest 里的 default，
 * 所以兜底值必须写在这里。
 *
 * 默认为空：公开分发时不预设任何本机路径。需要「把 key 放在独立文件里
 * 由插件读取」的用户，在设置里填自己的路径即可（留空则跳过该来源）。
 */
const DEFAULT_KEY_FILE = '';

interface BalanceSnapshot {
  currency: string;
  total: number;
  granted: number | null;
  toppedUp: number | null;
  isAvailable: boolean | null;
  at: number;
}

interface Ledger {
  /** 北京时间日期 YYYY-MM-DD */
  date: string;
  /**
   * 今日 00:00 的余额基线。今日已用 = dayOpen - 当前余额。
   * 用基线而不是逐次累加，是为了跨进程重启、长时间不刷新都不丢账。
   */
  dayOpen: number | null;
  /** 上次查到的余额：用来识别充值（余额上涨）和跨天时的期初值 */
  lastBalance: number | null;
  currency: string;
  calls: number;
}

interface BalanceError {
  code: 'NO_KEY' | 'AUTH' | 'HTTP' | 'NETWORK' | 'PARSE' | 'SHAPE';
  message: string;
}

/** 北京时间下的 "YYYY-MM-DD"。 */
function beijingDayKey(ms = Date.now()): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingParts(sec: number) {
  const d = new Date(sec * 1000 + BEIJING_OFFSET_MS);
  return {
    day: d.toISOString().slice(0, 10),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
  };
}

function isPeakTime(sec: number): boolean {
  if (!Number.isFinite(sec)) return false;
  const { day, dow, hour } = beijingParts(sec);
  if (dow === 0 || dow === 6) return false; // 周末全天谷时
  if (HOLIDAY_VALLEY[day]) return false; // 法定节假日全天谷时
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

/** 下一个峰谷切换时刻（epoch 秒），与 isPeakTime 同源。 */
function nextSwitchAt(sec: number): number | null {
  const current = isPeakTime(sec);
  const dayStart = Math.floor((sec + 8 * 3600) / 86400) * 86400; // 北京当日 00:00（+8h 平移坐标）
  for (let d = 0; d <= 15; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = dayStart + d * 86400 + edge * 3600 - 8 * 3600;
      if (cand <= sec + 1) continue;
      if (isPeakTime(cand) !== current) return cand;
    }
  }
  return null;
}

function currencySymbol(currency: string): string {
  return currency === 'USD' ? '$' : '¥';
}

function money(value: number, currency: string): string {
  return `${currencySymbol(currency)}${value.toFixed(2)}`;
}

/** 把毫秒差写成「1 小时 5 分钟」这种。 */
/** 紧凑时长，给 tooltip 这种窄地方用：14h47m / 3d2h / 25m。 */
function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function clockTime(ms: number): string {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function activate(context: PluginContext): Promise<PluginActivation> {
  const { logger, events, ui, settings, storage } = context;
  logger.info('DeepSeek Balance plugin activated');

  const statusBarItem = ui.createStatusBarItem({
    id: 'deepseek-balance.statusBar',
    alignment: 'right',
    priority: 90,
  });
  statusBarItem.command = 'deepseek-balance.open';
  statusBarItem.text = '¥ —';
  statusBarItem.tooltip = 'DeepSeek 余额：正在初始化…';
  statusBarItem.show();

  const cfg = () => ({
    refreshMinutes: Math.min(Math.max(Number(settings.get<number>('deepseekBalance.refreshMinutes', 5)) || 5, 1), 1440),
    showToday: settings.get<boolean>('deepseekBalance.showToday', true),
    showPeak: settings.get<boolean>('deepseekBalance.showPeak', true),
    lowBalance: Number(settings.get<number>('deepseekBalance.lowBalance', 5)) || 0,
    providerId: settings.get<string>('deepseekBalance.providerId', 'deepseek') || 'deepseek',
    apiKeyOverride: (settings.get<string>('deepseekBalance.apiKey', '') || '').trim(),
    apiKeyFile: (settings.get<string>('deepseekBalance.apiKeyFile', DEFAULT_KEY_FILE) || '').trim(),
  });

  let snapshot: BalanceSnapshot | null = null;
  let lastError: BalanceError | null = null;
  let lastSuccessAt = 0;
  let previousTotal: number | null = null;
  let inFlight: Promise<void> | null = null;
  let apiKey: string | null = null;
  let keySource: 'manual' | 'file' | 'secret' | 'alma' | 'none' = 'none';
  let deepseekProviderIds = new Set<string>();
  let ledger: Ledger = { date: beijingDayKey(), dayOpen: null, lastBalance: null, currency: 'CNY', calls: 0 };
  let lastAttemptAt = 0;

  // ---------- 存储 ----------

  const ledgerLoaded = (async () => {
    try {
      const saved = await storage.local.get<any>('ledger');
      if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
        const lastBalance = toNumberOrNull(saved.lastBalance);
        let dayOpen = toNumberOrNull(saved.dayOpen);
        // 旧格式只有累加的 spend：反推基线 = 上次余额 + 已用
        if (dayOpen === null && lastBalance !== null) {
          const legacySpend = toNumberOrNull(saved.spend);
          if (legacySpend !== null) dayOpen = lastBalance + legacySpend;
        }
        ledger = {
          date: saved.date,
          dayOpen,
          lastBalance,
          currency: saved.currency || 'CNY',
          calls: Number.isFinite(saved.calls) ? Number(saved.calls) : 0,
        };
      }
    } catch (err) {
      logger.warn('读取今日账本失败，使用空账本：', err);
    }
    rolloverIfNeeded();
  })();

  function rolloverIfNeeded(): boolean {
    const today = beijingDayKey();
    if (ledger.date === today) return false;
    // 跨天：昨天的收盘余额就是今天的期初基线
    ledger = {
      date: today,
      dayOpen: ledger.lastBalance,
      lastBalance: ledger.lastBalance,
      currency: ledger.currency,
      calls: 0,
    };
    return true;
  }

  async function persistLedger(): Promise<void> {
    try {
      await storage.local.set('ledger', ledger);
    } catch (err) {
      logger.warn('保存今日账本失败：', err);
    }
  }

  // ---------- API Key ----------

  function almaPort(): number {
    const raw = Number.parseInt(String((process as any)?.env?.ALMA_PORT ?? ''), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 23001;
  }

  /** 从 Alma 自己的提供商里取 DeepSeek 的 Key；顺手记下哪些 providerId 属于 DeepSeek。 */
  async function discoverFromAlma(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${almaPort()}/api/providers`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return;
      const list = (await res.json()) as Array<{
        id: string;
        type?: string;
        apiKey?: string;
        baseURL?: string;
        enabled?: boolean;
      }>;
      if (!Array.isArray(list)) return;

      deepseekProviderIds = new Set(
        list.filter((p) => p && (p.type === 'deepseek' || /deepseek/i.test(p.id || ''))).map((p) => p.id),
      );

      const wanted = cfg().providerId;
      const picked =
        list.find((p) => p.id === wanted) ||
        list.find((p) => p.type === 'deepseek') ||
        list.find((p) => /deepseek/i.test(p.id || ''));
      if (!picked) return;

      // 走中转/代理的 Key 不能拿去查官方余额，跳过自动读取
      const base = (picked.baseURL || '').trim();
      if (base && !/deepseek\.com/i.test(base)) {
        logger.info(`提供商 ${picked.id} 使用自定义 baseURL，跳过自动读取 Key`);
        return;
      }

      const key = (picked.apiKey || '').trim();
      if (key) {
        apiKey = key;
        keySource = 'alma';
        logger.info(`已从 Alma 提供商 ${picked.id} 读取 API Key`);
      }
    } catch (err) {
      logger.debug('读取 Alma 提供商失败（忽略）：', err);
    }
  }

  /** 从指定文件读 Key；文件内容可能是带引号/BOM/换行的，统一清洗。读不到就返回 null。 */
  async function readKeyFromFile(filePath: string): Promise<string | null> {
    try {
      const raw = await context.workspace.readFile(filePath);
      const text = new TextDecoder('utf-8').decode(raw);
      const key = text
        .replace(/^﻿/, '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
      if (/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
        logger.info(`已从密钥文件读取 API Key（${filePath}）`);
        return key;
      }
      if (key) logger.warn(`密钥文件格式不像 DeepSeek Key，已忽略（${filePath}）`);
      return null;
    } catch (err: any) {
      logger.warn(`读取密钥文件失败（${filePath}）：${err?.message || err}`);
      return null;
    }
  }

  async function resolveKey(force = false): Promise<string | null> {
    if (apiKey && !force) return apiKey;

    const override = cfg().apiKeyOverride;
    if (override) {
      apiKey = override;
      keySource = 'manual';
      return apiKey;
    }

    try {
      const secret = await storage.secrets.get('deepseekApiKey');
      if (secret && secret.trim()) {
        apiKey = secret.trim();
        keySource = 'secret';
        return apiKey;
      }
    } catch (err) {
      logger.debug('读取 secret 失败（忽略）：', err);
    }

    const keyFile = cfg().apiKeyFile;
    if (keyFile) {
      const fromFile = await readKeyFromFile(keyFile);
      if (fromFile) {
        apiKey = fromFile;
        keySource = 'file';
        return apiKey;
      }
    }

    await discoverFromAlma();
    if (!apiKey) keySource = 'none';
    return apiKey;
  }

  // ---------- 余额 ----------

  async function fetchBalance(key: string): Promise<BalanceSnapshot> {
    let lastErr: any = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw { code: 'AUTH', message: `API Key 无效或无权限（HTTP ${res.status}）` } as BalanceError;
        }
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status < 500) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        throw { code: 'PARSE', message: '余额接口返回的不是合法 JSON' } as BalanceError;
      }

      const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
      const info =
        infos.find((x: any) => String(x?.currency).toUpperCase() === 'CNY') || infos[0] || null;
      const total = toNumberOrNull(info?.total_balance);
      if (!info || total === null) {
        throw { code: 'SHAPE', message: '余额接口返回结构异常（缺 total_balance）' } as BalanceError;
      }

      return {
        currency: String(info.currency || 'CNY').toUpperCase(),
        total,
        granted: toNumberOrNull(info.granted_balance),
        toppedUp: toNumberOrNull(info.topped_up_balance),
        isAvailable: typeof data?.is_available === 'boolean' ? data.is_available : null,
        at: Date.now(),
      };
    }

    throw { code: 'NETWORK', message: `余额请求失败：${lastErr?.message || lastErr || '未知错误'}` } as BalanceError;
  }

  /**
   * 维护今日基线：
   *  - 余额下跌 → 不动基线，今日已用 = dayOpen - 当前余额，自然增长
   *  - 余额上涨 → 视为充值，把基线同步抬高，今日已用保持不倒退
   */
  function applyToLedger(snap: BalanceSnapshot): void {
    rolloverIfNeeded();

    if (ledger.currency !== snap.currency) {
      ledger.currency = snap.currency;
      ledger.dayOpen = snap.total;
      ledger.lastBalance = snap.total;
      return;
    }

    if (ledger.dayOpen === null) {
      // 今天第一次见到数据：还不知道 00:00 时是多少，先以现在为基线（今日已用从 0 开始）
      ledger.dayOpen = snap.total;
      ledger.lastBalance = snap.total;
      return;
    }

    if (ledger.lastBalance !== null) {
      const rise = snap.total - ledger.lastBalance;
      if (rise > 0.0001) {
        ledger.dayOpen = Math.round((ledger.dayOpen + rise) * 1e4) / 1e4;
      }
    }
    ledger.lastBalance = snap.total;
  }

  /** 只露尾号，用于界面和日志里说明"正在用哪个 key"。绝不输出完整 key。 */
  function maskKey(): string {
    if (!apiKey) return '';
    const tail = apiKey.slice(-4);
    return apiKey.startsWith('sk-') ? `sk-••••${tail}` : `••••${tail}`;
  }

  function keySourceLabel(): string {
    switch (keySource) {
      case 'manual':
        return '插件设置里手填';
      case 'file':
        return '密钥文件';
      case 'secret':
        return '加密保存';
      case 'alma':
        return 'Alma 提供商';
      default:
        return '未配置';
    }
  }

  /** 今日已用 = 期初基线 - 当前余额，夹在 0 以上并抹掉浮点尾巴。 */
  function todaySpendOf(s: BalanceSnapshot): number {
    if (ledger.date !== beijingDayKey() || ledger.dayOpen === null) return 0;
    const spend = ledger.dayOpen - s.total;
    return Math.round(Math.max(0, spend) * 1e4) / 1e4;
  }

  /** 用平台上的今日已用金额校准基线（用户手动填一次，之后就准了）。 */
  async function calibrateToday(spentToday: number): Promise<void> {
    if (!snapshot || !Number.isFinite(spentToday) || spentToday < 0) return;
    rolloverIfNeeded();
    ledger.dayOpen = Math.round((snapshot.total + spentToday) * 1e4) / 1e4;
    ledger.lastBalance = snapshot.total;
    await persistLedger();
    logger.info(`已校准今日基线：今日已用 ${money(spentToday, ledger.currency)}`);
    render();
  }

  async function refresh(reason: string, force = false): Promise<void> {
    if (inFlight) return inFlight;
    // 非手动触发时做节流：余额接口没必要被打得太勤
    const throttleMs = 45_000;
    if (!force && Date.now() - lastAttemptAt < throttleMs) return;
    lastAttemptAt = Date.now();

    inFlight = (async () => {
      await ledgerLoaded;
      const key = await resolveKey();
      if (!key) {
        lastError = { code: 'NO_KEY', message: '还没拿到 DeepSeek API Key' };
        lastSuccessAt = 0;
        render();
        return;
      }

      try {
        const snap = await fetchBalance(key);
        applyToLedger(snap);
        if (snapshot && snapshot.currency === snap.currency && Math.abs(snapshot.total - snap.total) >= 0.005) {
          previousTotal = snapshot.total;
        }
        snapshot = snap;
        lastError = null;
        lastSuccessAt = snap.at;
        await persistLedger();
        logger.info(`余额刷新成功（${reason}）：${money(snap.total, snap.currency)}`);
      } catch (err: any) {
        lastError =
          err && typeof err.code === 'string' && typeof err.message === 'string'
            ? (err as BalanceError)
            : { code: 'NETWORK', message: String(err?.message || err) };
        logger.warn(`余额刷新失败（${reason}）：`, lastError.message);
      } finally {
        render();
        inFlight = null;
      }
    })();

    return inFlight;
  }

  // ---------- 渲染 ----------

  function peakLabel(nowSec: number) {
    const peak = isPeakTime(nowSec);
    const next = nextSwitchAt(nowSec);
    return {
      peak,
      next,
      text: peak ? '峰时 · 标准价' : '谷时 · 5 折',
      remain: next ? `${humanDuration(next * 1000 - nowSec * 1000)}后转${peak ? '谷时' : '峰时'}` : '',
    };
  }

  let statusText = '';
  let statusTooltip = '';

  function setStatus(text: string, tooltip: string): void {
    if (text !== statusText) {
      statusText = text;
      statusBarItem.text = text;
    }
    if (tooltip !== statusTooltip) {
      statusTooltip = tooltip;
      statusBarItem.tooltip = tooltip;
    }
  }

  function render(): void {
    const c = cfg();
    const nowSec = Math.floor(Date.now() / 1000);

    if (!snapshot) {
      if (lastError?.code === 'NO_KEY') {
        setStatus(
          '¥ — 未设置 Key',
          'DeepSeek 余额：没找到 API Key\n点击可手动填写，或先在 Alma 里配置 DeepSeek 提供商',
        );
      } else if (lastError) {
        setStatus(
          '¥ ! 点击重试',
          `DeepSeek 余额获取失败\n${lastError.message}\n点击查看详情或重试`,
        );
      } else {
        setStatus('¥ …', 'DeepSeek 余额：查询中…');
      }
      return;
    }

    const s = snapshot;
    const todaySpend = todaySpendOf(s);
    const low = c.lowBalance > 0 && s.total < c.lowBalance;

    let text = `${money(s.total, s.currency)}`;
    if (c.showToday) text += ` · 今日 ${money(todaySpend, s.currency)}`;
    if (low) text = `⚠ ${text}`;

    // 排版原则：主数字一行、分项一行、状态一行、落款一行。
    // 括号里的解释全部砍掉 —— tooltip 只回答"现在什么情况"，细节点进弹窗看。
    const lines: string[] = ['DeepSeek 余额', ''];

    // 主数字：余额 + 今日
    const head = [`余额 ${money(s.total, s.currency)}`];
    if (c.showToday) head.push(`今日 ${money(todaySpend, s.currency)}`);
    lines.push(head.join('   ·   '));

    // 分项：接口没给就整行不显示，不留"接口未提供"这种空话
    if (s.toppedUp !== null) {
      const granted = s.granted !== null ? money(s.granted, s.currency) : '—';
      lines.push(`充值 ${money(s.toppedUp, s.currency)}   ·   赠金 ${granted}`);
    }

    // 峰谷：一行说清"现在"和"多久后变"
    if (c.showPeak) {
      const p = peakLabel(nowSec);
      const left = p.next ? shortDuration(p.next * 1000 - nowSec * 1000) : '';
      const state = p.peak ? '峰时 · 标准价' : '谷时 · 5 折';
      lines.push(left ? `${state}   ·   ${left}后转${p.peak ? '谷' : '峰'}` : state);
    }

    // 警告只在真有问题时出现
    if (s.isAvailable === false) lines.push('⚠ 余额不足，API 调用可能被拒绝');
    if (low) lines.push(`⚠ 低于 ${money(c.lowBalance, s.currency)}`);

    // 落款：更新时间 · 用哪个 key（只露尾号）
    const masked = maskKey();
    const stamp = [`${clockTime(s.at)} 更新`];
    if (masked) stamp.push(masked);
    lines.push('');
    lines.push(stamp.join('   ·   '));
    if (lastError) lines.push(`⚠ 最近刷新失败：${lastError.message}`);

    setStatus(text, lines.join('\n'));
  }

  // ---------- 弹窗 ----------

  let panelOpen = false;

  async function openPanel(): Promise<void> {
    if (panelOpen) return; // 连点状态栏不要叠出一摞弹窗
    panelOpen = true;
    try {
      await openPanelInner();
    } finally {
      panelOpen = false;
    }
  }

  async function openPanelInner(): Promise<void> {
    const c = cfg();
    const nowSec = Math.floor(Date.now() / 1000);
    const s = snapshot;
    const todaySpend = s ? todaySpendOf(s) : 0;
    const cur = s?.currency || ledger.currency || 'CNY';

    type Row = { label: string; description?: string; detail?: string; value: string };
    const rows: Row[] = [];

    if (s) {
      rows.push({
        label: money(s.total, cur),
        description: '总余额',
        detail:
          s.toppedUp !== null
            ? `充值 ${money(s.toppedUp, cur)} · 赠金 ${s.granted !== null ? money(s.granted, cur) : '—'}`
            : '',
        value: 'refresh',
      });
      rows.push({
        label: money(todaySpend, cur),
        description: '今日已用',
        detail: ledger.dayOpen !== null ? `基线 ${money(ledger.dayOpen, cur)} − 当前余额` : '',
        value: 'noop',
      });
      rows.push({
        label: '校准今日已用',
        description: '对不上平台数字时用',
        value: 'calibrate',
      });
      if (previousTotal !== null && Math.abs(previousTotal - s.total) >= 0.005) {
        const diff = s.total - previousTotal;
        rows.push({
          label: `${diff > 0 ? '+' : '-'}${money(Math.abs(diff), cur)}`,
          description: '较上次查询',
          detail: `上次 ${money(previousTotal, cur)}`,
          value: 'noop',
        });
      }
    } else {
      rows.push({
        label: '余额未知',
        description: lastError?.code === 'NO_KEY' ? '未配置 Key' : '查询失败',
        detail: lastError?.message || '正在查询…',
        value: 'refresh',
      });
    }

    if (c.showPeak) {
      const p = peakLabel(nowSec);
      rows.push({
        label: p.text,
        description: p.remain || '',
        detail: '工作日 9–12、14–18 点为峰时，其余 5 折',
        value: 'noop',
      });
    }

    rows.push({
      label: '刷新余额',
      description: s ? `上次更新 ${clockTime(s.at)}` : '现在查询',
      value: 'refresh',
    });

    rows.push({
      label: '设置 API Key',
      description: `${keySourceLabel()}${maskKey() ? ` · ${maskKey()}` : ''}`,
      value: 'setkey',
    });
    if (keySource === 'manual' || keySource === 'secret') {
      rows.push({ label: '清除手动 Key，改回自动读取', value: 'clearkey' });
    }
    rows.push({ label: '打开 DeepSeek 用量页', description: 'platform.deepseek.com', value: 'usage' });

    const picked = await ui.showQuickPick(rows, {
      title: 'DeepSeek 余额',
      placeholder: '选择一项',
    });

    if (!picked) return;

    if (picked === 'refresh') {
      await refresh('panel', true);
      return;
    }

    if (picked === 'usage') {
      await (ui as any).openExternal?.(USAGE_PAGE);
      return;
    }

    if (picked === 'calibrate') {
      const input = await ui.showInputBox({
        title: '校准今日已用',
        prompt: '填 DeepSeek 平台上这个 key 今天已消费的金额（元），例如 5.07',
        placeholder: '5.07',
        value: todaySpend > 0 ? String(todaySpend) : '',
      });
      const spent = Number((input || '').trim().replace(/[¥￥,\s]/g, ''));
      if (!Number.isFinite(spent) || spent < 0) {
        ui.showNotification('金额格式不对，没改动', { type: 'warning' });
        return;
      }
      await calibrateToday(spent);
      ui.showNotification(`今日已用已校准为 ${money(spent, cur)}`, { type: 'success' });
      return;
    }

    if (picked === 'setkey') {
      const input = await ui.showInputBox({
        title: 'DeepSeek API Key',
        prompt: '粘贴以 sk- 开头的 API Key（只保存在本机）',
        password: true,
        placeholder: 'sk-...',
        value: '',
      });
      const key = (input || '').trim();
      if (!key) return;
      await storage.secrets.set('deepseekApiKey', key);
      apiKey = null;
      await resolveKey(true);
      lastError = null;
      snapshot = null;
      render();
      await refresh('manual-key', true);
      return;
    }

    if (picked === 'clearkey') {
      try {
        await storage.secrets.delete('deepseekApiKey');
      } catch (err) {
        logger.warn('删除 secret 失败：', err);
      }
      if (cfg().apiKeyOverride) {
        await settings.update('deepseekBalance.apiKey', '');
      }
      apiKey = null;
      keySource = 'none';
      snapshot = null;
      lastError = null;
      render();
      await refresh('cleared-key', true);
    }
  }

  // ---------- 事件与定时 ----------

  const disposables: Array<{ dispose(): void }> = [];

  disposables.push(
    events.on('chat.message.didReceive', (input) => {
      const pid = (input as any)?.providerId as string | undefined;
      const isDeepseek = pid ? deepseekProviderIds.has(pid) || /deepseek/i.test(pid) : false;
      if (!isDeepseek) return;
      rolloverIfNeeded();
      ledger.calls += 1;
      void persistLedger();
      // 余额不会实时更新，收到消息后延后一点再查，避免拿到尚未入账的数
      void refresh('after-message');
    }),
  );

  disposables.push(
    events.on('thread.activated', () => {
      void refresh('thread-activated');
    }),
  );

  const refreshCommand = context.commands.register('refresh', async () => {
    await refresh('command', true);
    ui.showNotification(
      snapshot ? `余额 ${money(snapshot.total, snapshot.currency)}` : lastError?.message || '刷新失败',
      { type: snapshot ? 'success' : 'warning' },
    );
  });
  disposables.push(refreshCommand);

  const openCommand = context.commands.register('open', async () => {
    await openPanel();
  });
  disposables.push(openCommand);

  let timer: ReturnType<typeof setInterval> | null = null;
  function startTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh('timer'), cfg().refreshMinutes * 60_000);
  }
  startTimer();

  // 只重绘、不发请求：让 tooltip 里的峰谷倒计时保持新鲜（内容没变时不会产生 UI 更新）
  const ticker = setInterval(() => render(), 30_000);

  disposables.push(
    settings.onDidChange(() => {
      startTimer();
      apiKey = null; // 可能改了 apiKey/apiKeyFile，强制重新解析
      void refresh('settings-changed', true);
    }),
  );

  // 首次查询
  void refresh('startup');

  return {
    dispose: () => {
      if (timer) clearInterval(timer);
      clearInterval(ticker);
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (err) {
          logger.warn('dispose 失败：', err);
        }
      }
      statusBarItem.dispose();
      logger.info('DeepSeek Balance plugin deactivated');
    },
  };
}
