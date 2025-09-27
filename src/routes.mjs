import express from "express";
import { crawlAllBanks } from "./crawler.mjs";
import {
    persistSnapshots,
    getLatest,
    getDailyClose,
    getDailyOHLC,
    getHistoryDailyClose,
    getBestToday,
    upsertSnapshotsFromPayload,
    normalizeSnapshotPayload,
    getHistoryDailyCloseMulti,
    getLatestAllBanksByCode,
} from "./services.mjs";
import { addDays } from "date-fns";

const router = express.Router();

/** helper: parse field param */
function pickField(q) {
    const f = (q.field || "sell").toString();
    if (!["sell", "buy_cash", "buy_transfer"].includes(f)) return "sell";
    return f;
}

/** helper: day range in Asia/Bangkok */
function dayRange(dateStr) {
    // dateStr: 'YYYY-MM-DD'
    const d = dateStr ? new Date(`${dateStr}T00:00:00+07:00`) : new Date();
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

/** helper: range window */
function rangeWindow(rangeKey) {
    const now = new Date();
    const end = new Date(now);
    let start = new Date(now);
    switch (rangeKey) {
        case "1w":
            start.setDate(start.getDate() - 7);
            break;
        case "1m":
            start.setMonth(start.getMonth() - 1);
            break;
        case "3m":
            start.setMonth(start.getMonth() - 3);
            break;
        case "1y":
            start.setFullYear(start.getFullYear() - 1);
            break;
        default:
            start.setMonth(start.getMonth() - 1); // mặc định 1m
    }
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

/** API: trigger crawl thủ công (bảo vệ bằng TOKEN nếu cần) */
router.post("/admin/crawl-now", async (req, res) => {
    try {
        const rows = await crawlAllBanks();
        const persisted = await persistSnapshots(rows, new Date());
        res.json({ ok: true, count: rows.length, persisted });
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

/** API: latest — GET /api/latest?bank=vietcombank&code=USD&field=sell */
router.get("/latest", async (req, res) => {
    try {
        const bank = req.query.bank?.toString().toLowerCase();
        const code = req.query.code?.toString().toUpperCase();
        if (!bank || !code)
            return res.status(400).json({ error: "bank & code required" });

        // field: sell | buy_cash | buy_transfer
        const field = pickField(req.query);

        // 1) lấy snapshot mới nhất
        const latest = await getLatest(bank, code);
        if (!latest) return res.status(404).json({ error: "not found" });

        const latestVal = latest[field] ?? null;

        // 2) lấy "đóng cửa" ngày hôm qua theo timezone VN
        const now = new Date();
        const y = new Date(now);
        y.setDate(y.getDate() - 1);

        const { start, end } = dayRange(y.toISOString().slice(0, 10));
        const yClose = await getDailyClose(bank, code, start, end);
        const yVal = yClose ? yClose[field] ?? null : null;

        // 3) tính chênh lệch & %
        const change =
            latestVal != null && yVal != null ? latestVal - yVal : null;
        const pct = change != null && yVal ? change / yVal : null;

        // 4) tạo câu tóm tắt VN
        const fmt = new Intl.NumberFormat("vi-VN");
        const bankNameVN = bank.charAt(0).toUpperCase() + bank.slice(1); // đơn giản
        const fieldVN = {
            sell: "bán ra",
            buy_cash: "mua tiền mặt",
            buy_transfer: "mua chuyển khoản",
        }[field];

        let summary = null;
        if (latestVal != null && yVal != null) {
            const dir = change > 0 ? "tăng" : change < 0 ? "giảm" : "không đổi";
            const pctStr =
                pct != null
                    ? pct >= 0
                        ? `(+${(pct * 100).toFixed(2)}%)`
                        : `(${(pct * 100).toFixed(2)}%)`
                    : "";
            const deltaStr = change
                ? `${change > 0 ? "+" : ""}${fmt.format(change)} VND`
                : "0 VND";
            summary = `Tỷ giá ${code} (${fieldVN}) ngân hàng ${bankNameVN} so với ngày hôm qua ${dir} ${deltaStr} ${pctStr}.`;
        }

        res.json({
            bank,
            code,
            field,
            periodStart: latest.periodStart,
            value: latestVal,
            yesterday_close: {
                at: yClose?.periodStart ?? null,
                value: yVal,
            },
            change, // ví dụ: -100
            pct, // ví dụ: -0.005 (tức -0.5%)
            summary, // câu tiếng Việt như bạn yêu cầu
            doc: latest, // giữ nguyên tài liệu đầy đủ
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** API: compare with yesterday close
 * GET /api/compare?bank=vietcombank&code=USD&field=sell
 */
router.get("/compare", async (req, res) => {
    try {
        const bank = req.query.bank?.toString().toLowerCase();
        const code = req.query.code?.toString().toUpperCase();
        if (!bank || !code)
            return res.status(400).json({ error: "bank & code required" });
        const field = pickField(req.query);

        const latest = await getLatest(bank, code);
        if (!latest) return res.status(404).json({ error: "no latest data" });

        const now = new Date();
        const y = new Date(now);
        y.setDate(y.getDate() - 1);
        const { start, end } = dayRange(y.toISOString().slice(0, 10));
        const yClose = await getDailyClose(bank, code, start, end);

        const latestVal = latest[field] ?? null;
        const yCloseVal = yClose ? yClose[field] ?? null : null;
        const change =
            latestVal != null && yCloseVal != null
                ? latestVal - yCloseVal
                : null;
        const pct = change != null && yCloseVal ? change / yCloseVal : null;

        res.json({
            bank,
            code,
            field,
            latest: { at: latest.periodStart, value: latestVal },
            yesterday_close: {
                at: yClose?.periodStart ?? null,
                value: yCloseVal,
            },
            change,
            pct,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** API: history by range (daily close)
 * GET /api/history?bank=vietcombank&code=USD&range=1m&field=sell
 */
router.get("/history", async (req, res) => {
    // try {
    //     const bank = req.query.bank?.toString().toLowerCase();
    //     const code = req.query.code?.toString().toUpperCase();
    //     if (!bank || !code)
    //         return res.status(400).json({ error: "bank & code required" });
    //     const field = pickField(req.query);
    //     const { start, end } = rangeWindow(req.query.range?.toString() || "1m");

    //     const series = await getHistoryDailyClose(
    //         bank,
    //         code,
    //         start,
    //         end,
    //         field
    //     );
    //     res.json({ bank, code, field, range: { start, end }, series });
    // } catch (e) {
    //     res.status(500).json({ error: e.message });
    // }

    try {
        const bank = req.query.bank?.toString().toLowerCase();
        const code = req.query.code?.toString().toUpperCase();
        if (!bank || !code)
            return res.status(400).json({ error: "bank & code required" });

        const { start, end } = rangeWindow(req.query.range?.toString() || "1m");

        // fields parsing
        const raw = (req.query.fields || "all").toString().toLowerCase();
        const fields =
            raw === "all"
                ? ["buy_cash", "buy_transfer", "sell"]
                : raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);

        const series = await getHistoryDailyCloseMulti(
            bank,
            code,
            start,
            end,
            fields
        );

        res.json({
            bank,
            code,
            fields: fields,
            range: { start, end },
            series,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** API: daily OHLC
 * GET /api/daily-ohlc?bank=vietcombank&code=USD&date=2025-09-16&field=sell
 */
router.get("/daily-ohlc", async (req, res) => {
    try {
        const bank = req.query.bank?.toString().toLowerCase();
        const code = req.query.code?.toString().toUpperCase();
        if (!bank || !code)
            return res.status(400).json({ error: "bank & code required" });

        const field = pickField(req.query);
        const dateStr =
            req.query.date?.toString() || new Date().toISOString().slice(0, 10);
        const { start, end } = dayRange(dateStr);

        const ohlc = await getDailyOHLC(bank, code, start, end, field);
        res.json({ bank, code, ...ohlc });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** API: best today (min sell, max buy_cash, max buy_transfer)
 * GET /api/best-today?code=USD
 * Optional: ?date=YYYY-MM-DD  (mặc định hôm nay theo Asia/Bangkok)
 */
router.get("/best-today", async (req, res) => {
    try {
        const code = req.query.code?.toString().toUpperCase();
        if (!code)
            return res.status(400).json({ error: "code required (e.g., USD)" });

        const dateStr =
            req.query.date?.toString() || new Date().toISOString().slice(0, 10);
        const { start, end } = dayRange(dateStr);

        const best = await getBestToday(code, start, end);
        res.json({ code, date: dateStr, ...best });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** API: tạo 1 snapshot (upsert theo bank+code+periodStart)
 * POST /api/admin/snapshot
 * Body JSON:
 * {
 *   "bank": "vietcombank",
 *   "code": "USD",
 *   "name": "ĐÔ LA MỸ",
 *   "buy_cash": 26147,
 *   "buy_transfer": 26177,
 *   "sell": 26457,
 *   "periodStart": "2025-09-16T10:15:00+07:00", // optional -> làm tròn về 10:00
 *   "source": "https://example.com"
 * }
 */
router.post("/admin/snapshot", async (req, res) => {
    try {
        const one = normalizeSnapshotPayload(req.body || {});
        const r = await upsertSnapshotsFromPayload([one]);
        res.json({ ok: true, result: r, item: one });
    } catch (e) {
        res.status(400).json({ ok: false, message: e.message });
    }
});

/** API: tạo nhiều snapshot
 * POST /api/admin/snapshots
 * Body JSON:
 * { "items": [ {bank, code, ...}, {bank, code, ...}, ... ] }
 */
router.post("/admin/snapshots", async (req, res) => {
    try {
        const raw = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!raw.length)
            return res
                .status(400)
                .json({ ok: false, message: "items[] is required" });

        const r = await upsertSnapshotsFromPayload(raw);
        res.json({ ok: true, count: raw.length, result: r });
    } catch (e) {
        res.status(400).json({ ok: false, message: e.message });
    }
});

/** API: latest of ALL banks for one currency
 * GET /api/latest-all?code=USD
 * Optional: fields=all | buy_cash,buy_transfer | sell (mặc định all)
 */
router.get("/latest-all", async (req, res) => {
    try {
        const code = req.query.code?.toString().toUpperCase();
        if (!code) return res.status(400).json({ error: "code required (e.g., USD)" });

        const raw = (req.query.fields || "all").toString().toLowerCase();
        const fields = raw === "all"
            ? ["buy_cash", "buy_transfer", "sell"]
            : raw.split(",").map(s => s.trim()).filter(Boolean);

        const { as_of, items } = await getLatestAllBanksByCode(code, fields);

        res.json({
            code,
            fields,
            as_of,                // thời điểm mới nhất trong tập dữ liệu
            banks: items.map(d => ({
                bank: d.bank,
                periodStart: d.periodStart,
                name: d.name ?? null,
                source: d.source ?? null,
                ...Object.fromEntries(fields.map(f => [f, d[f] ?? null]))
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
