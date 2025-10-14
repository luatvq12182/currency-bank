import { RateSnapshot } from "./models/RateSnapshot.mjs";
import { addHours, startOfHour } from "date-fns";

/** Làm tròn về đầu giờ để tránh trùng snapshot trong cùng 1 giờ */
export function roundToHour(date = new Date()) {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
}

/** Lưu 1 loạt snapshot (upsert theo bank+code+periodStart) */
export async function persistSnapshots(items, at = new Date()) {
    const periodStart = roundToHour(at); // đầu giờ hiện tại
    const ops = items.map((doc) => ({
        updateOne: {
            filter: { bank: doc.bank, code: doc.code, periodStart },
            update: { $set: { ...doc, periodStart } },
            upsert: true,
        },
    }));
    if (!ops.length) return { upserted: 0, modified: 0 };
    const res = await RateSnapshot.bulkWrite(ops, { ordered: false });
    return {
        upserted: res.upsertedCount || 0,
        modified: res.modifiedCount || 0,
        matched: res.matchedCount || 0,
    };
}

/** lấy snapshot mới nhất */
export async function getLatest(bank, code) {
    return RateSnapshot.findOne({ bank, code })
        .sort({ periodStart: -1 })
        .lean();
}

/** lấy "đóng cửa" (snapshot cuối cùng) của 1 ngày theo timezone Asia/Bangkok */
export async function getDailyClose(bank, code, dayStart, dayEnd) {
    return RateSnapshot.findOne({
        bank,
        code,
        periodStart: { $gte: dayStart, $lte: dayEnd },
    })
        .sort({ periodStart: -1 })
        .lean();
}

/** lấy "mở cửa" (snapshot đầu tiên) của 1 ngày */
export async function getDailyOpen(bank, code, dayStart, dayEnd) {
    return RateSnapshot.findOne({
        bank,
        code,
        periodStart: { $gte: dayStart, $lte: dayEnd },
    })
        .sort({ periodStart: 1 })
        .lean();
}

/** OHLC của 1 ngày cho 1 field (sell | buy_cash | buy_transfer) */
export async function getDailyOHLC(bank, code, dayStart, dayEnd, field) {
    // open/close: first/last
    const [openDoc, closeDoc] = await Promise.all([
        getDailyOpen(bank, code, dayStart, dayEnd),
        getDailyClose(bank, code, dayStart, dayEnd),
    ]);

    // high/low: min/max trong ngày
    const agg = await RateSnapshot.aggregate([
        {
            $match: {
                bank,
                code,
                periodStart: { $gte: dayStart, $lte: dayEnd },
            },
        },
        {
            $group: {
                _id: null,
                high: { $max: `$${field}` },
                low: { $min: `$${field}` },
            },
        },
    ]);
    const high = agg[0]?.high ?? null;
    const low = agg[0]?.low ?? null;

    return {
        date: dayStart.toISOString().slice(0, 10),
        field,
        open: openDoc ? openDoc[field] ?? null : null,
        high,
        low,
        close: closeDoc ? closeDoc[field] ?? null : null,
    };
}

/** lịch sử daily close trong [from, to], trả về [{date, value}] */
export async function getHistoryDailyClose(bank, code, from, to, field) {
    // group theo ngày (theo Asia/Bangkok) và lấy snapshot cuối ngày
    // Tip: group thủ công bằng JS cho tương thích mọi version Mongo
    const docs = await RateSnapshot.find({
        bank,
        code,
        periodStart: { $gte: from, $lte: to },
    })
        .sort({ periodStart: 1 })
        .lean();

    const byDay = new Map(); // key YYYY-MM-DD -> lastDoc
    for (const d of docs) {
        const local = new Date(d.periodStart.getTime());
        // chuyển sang Asia/Bangkok bằng offset (đã đặt TZ=Asia/Bangkok, periodStart theo giờ local)
        const key = local.toISOString().slice(0, 10); // an toàn vì TZ=Asia/Bangkok trong env
        const prev = byDay.get(key);
        if (!prev || prev.periodStart < d.periodStart) byDay.set(key, d);
    }
    return [...byDay.entries()].map(([date, doc]) => ({
        date,
        value: doc[field] ?? null,
    }));
}

/** lịch sử daily close trả về nhiều trường giá trên mỗi ngày */
export async function getHistoryDailyCloseMulti(
    bank,
    code,
    from,
    to,
    fields = ["buy_cash", "buy_transfer", "sell"]
) {
    const allow = new Set(["buy_cash", "buy_transfer", "sell"]);
    const chosen = fields.filter((f) => allow.has(f));
    if (!chosen.length) throw new Error("no valid fields selected");

    const docs = await RateSnapshot.find({
        bank,
        code,
        periodStart: { $gte: from, $lte: to },
    })
        .sort({ periodStart: 1 })
        .lean();

    // group: lấy snapshot cuối của từng ngày
    const byDay = new Map(); // YYYY-MM-DD -> lastDoc
    for (const d of docs) {
        const key = new Date(d.periodStart.getTime())
            .toISOString()
            .slice(0, 10);
        const prev = byDay.get(key);
        if (!prev || prev.periodStart < d.periodStart) byDay.set(key, d);
    }

    // map => object chứa các trường đã chọn
    const series = [];
    for (const [date, doc] of byDay.entries()) {
        const item = { date };
        for (const f of chosen) item[f] = doc[f] ?? null;
        series.push(item);
    }

    // đảm bảo theo thứ tự ngày tăng dần
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return series;
}

/** Tìm ngân hàng có giá tốt nhất trong ngày (min sell, max buy_cash, max buy_transfer) */
export async function getBestToday(code, start, end) {
    // nhóm theo bank để lấy min/max trong ngày
    const perBank = await RateSnapshot.aggregate([
        { $match: { code, periodStart: { $gte: start, $lte: end } } },
        {
            $group: {
                _id: "$bank",
                minSell: { $min: "$sell" },
                maxBuyCash: { $max: "$buy_cash" },
                maxBuyTransfer: { $max: "$buy_transfer" },
            },
        },
    ]);

    let bestSell = null;
    let bestBuyCash = null;
    let bestBuyTransfer = null;

    for (const r of perBank) {
        if (r.minSell != null && (!bestSell || r.minSell < bestSell.value)) {
            bestSell = { bank: r._id, value: r.minSell };
        }
        if (
            r.maxBuyCash != null &&
            (!bestBuyCash || r.maxBuyCash > bestBuyCash.value)
        ) {
            bestBuyCash = { bank: r._id, value: r.maxBuyCash };
        }
        if (
            r.maxBuyTransfer != null &&
            (!bestBuyTransfer || r.maxBuyTransfer > bestBuyTransfer.value)
        ) {
            bestBuyTransfer = { bank: r._id, value: r.maxBuyTransfer };
        }
    }

    // Lấy thời điểm đạt mức giá đó (lấy snapshot muộn nhất trong ngày)
    const [sellDoc, buyCashDoc, buyTransferDoc] = await Promise.all([
        bestSell
            ? RateSnapshot.findOne({
                bank: bestSell.bank,
                code,
                periodStart: { $gte: start, $lte: end },
                sell: bestSell.value,
            })
                .sort({ periodStart: -1 })
                .lean()
            : null,
        bestBuyCash
            ? RateSnapshot.findOne({
                bank: bestBuyCash.bank,
                code,
                periodStart: { $gte: start, $lte: end },
                buy_cash: bestBuyCash.value,
            })
                .sort({ periodStart: -1 })
                .lean()
            : null,
        bestBuyTransfer
            ? RateSnapshot.findOne({
                bank: bestBuyTransfer.bank,
                code,
                periodStart: { $gte: start, $lte: end },
                buy_transfer: bestBuyTransfer.value,
            })
                .sort({ periodStart: -1 })
                .lean()
            : null,
    ]);

    return {
        best_sell: bestSell
            ? {
                bank: bestSell.bank,
                value: bestSell.value,
                at: sellDoc?.periodStart ?? null,
            }
            : null,
        best_buy_cash: bestBuyCash
            ? {
                bank: bestBuyCash.bank,
                value: bestBuyCash.value,
                at: buyCashDoc?.periodStart ?? null,
            }
            : null,
        best_buy_transfer: bestBuyTransfer
            ? {
                bank: bestBuyTransfer.bank,
                value: bestBuyTransfer.value,
                at: buyTransferDoc?.periodStart ?? null,
            }
            : null,
    };
}

/** Chuẩn hoá 1 item đầu vào từ API */
export function normalizeSnapshotPayload(input) {
    if (!input) throw new Error("Empty payload");
    const bank = input.bank?.toString().toLowerCase().trim();
    const code = input.code?.toString().toUpperCase().trim();
    if (!bank) throw new Error("bank is required");
    if (!code) throw new Error("code is required");

    // tên ngoại tệ (tùy)
    const name = input.name?.toString().trim() || null;

    // parse số an toàn
    const toNum = (v) =>
        v === null || v === undefined || v === "" || v === "-"
            ? null
            : Number(v);
    const buy_cash = toNum(input.buy_cash);
    const buy_transfer = toNum(input.buy_transfer);
    const sell = toNum(input.sell);

    // periodStart: chấp nhận ISO, "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm:ssZ", v.v.
    let periodStart;
    if (input.periodStart) {
        const d = new Date(input.periodStart);
        if (isNaN(d)) throw new Error("Invalid periodStart");
        periodStart = roundToHour(d);
    } else {
        periodStart = roundToHour(new Date()); // mặc định giờ hiện tại
    }

    const source = input.source?.toString() || null;

    return {
        bank,
        code,
        name,
        buy_cash,
        buy_transfer,
        sell,
        periodStart,
        source,
    };
}

/** Bulk upsert từ mảng items (đã normalize hoặc raw) */
export async function upsertSnapshotsFromPayload(itemsRaw) {
    const items = itemsRaw.map(normalizeSnapshotPayload);
    if (!items.length) return { upserted: 0, modified: 0, matched: 0 };

    const ops = items.map((doc) => ({
        updateOne: {
            filter: {
                bank: doc.bank,
                code: doc.code,
                periodStart: doc.periodStart,
            },
            update: { $set: doc },
            upsert: true,
        },
    }));

    const res = await RateSnapshot.bulkWrite(ops, { ordered: false });
    return {
        upserted: res.upsertedCount || 0,
        modified: res.modifiedCount || 0,
        matched: res.matchedCount || 0,
    };
}

/** Lấy snapshot mới nhất của TẤT CẢ ngân hàng cho 1 currency code */
export async function getLatestAllBanksByCode(code, fields = ["buy_cash", "buy_transfer", "sell"]) {
    const allow = new Set(["buy_cash", "buy_transfer", "sell", "name", "source", "periodStart", "bank", "code", "createdAt", "updatedAt"]);
    const proj = Object.fromEntries(
        [...fields, "bank", "code", "periodStart", "source", "name"].filter(f => allow.has(f)).map(f => [f, 1])
    );

    const docs = await RateSnapshot.aggregate([
        { $match: { code } },
        { $sort: { bank: 1, periodStart: -1 } },          // sort trước
        { $group: { _id: "$bank", doc: { $first: "$$ROOT" } } },  // lấy doc mới nhất mỗi bank
        { $replaceWith: "$doc" },
        { $project: proj },
        { $sort: { bank: 1 } }
    ]);

    // “as_of” là mốc thời gian mới nhất trong tất cả bản ghi
    const as_of = docs.reduce((mx, d) => {
        const t = d.periodStart ? new Date(d.periodStart).getTime() : 0;
        return t > mx ? t : mx;
    }, 0);

    return { as_of: as_of ? new Date(as_of) : null, items: docs };
}

/**
 * Lấy tất cả currency pairs mới nhất của 1 ngân hàng,
 * kèm so sánh với snapshot trước đó 24h.
 */
export async function getLatestAllPairsByBank(bank, fields = ["buy_cash", "buy_transfer", "sell"]) {
    // lấy doc mới nhất mỗi code cho bank này
    const latestDocs = await RateSnapshot.aggregate([
        { $match: { bank } },
        { $sort: { code: 1, periodStart: -1 } },
        { $group: { _id: "$code", doc: { $first: "$$ROOT" } } },
        { $replaceWith: "$doc" },
        { $sort: { code: 1 } }
    ]);

    const fmtVND = new Intl.NumberFormat("vi-VN");
    const signed = (v) => (v == null ? null : `${v > 0 ? "+" : v < 0 ? "" : ""}${fmtVND.format(v)} VND`);
    const pctText = (v) => (v == null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

    const items = [];
    for (const d of latestDocs) {
        const cutoff = new Date(new Date(d.periodStart).getTime() - 24 * 3600 * 1000);

        const prev = await RateSnapshot.findOne({
            bank: d.bank,
            code: d.code,
            periodStart: { $lte: cutoff }
        }).sort({ periodStart: -1 }).lean();

        const deltas = {};
        for (const f of fields) {
            const latestVal = d[f] ?? null;
            const prevVal = prev ? (prev[f] ?? null) : null;
            const change = (latestVal != null && prevVal != null) ? (latestVal - prevVal) : null;
            const pct = (change != null && prevVal) ? (change / prevVal) : null;
            let trend = null;
            if (change != null) trend = change > 0 ? "up" : change < 0 ? "down" : "flat";

            deltas[f] = {
                prev_value: prevVal,
                change,
                change_text: signed(change),
                pct,
                pct_text: pctText(pct),
                trend
            };
        }

        items.push({
            code: d.code,
            name: d.name ?? null,
            periodStart: d.periodStart,
            source: d.source ?? null,
            ...Object.fromEntries(fields.map(f => [f, d[f] ?? null])),
            deltas
        });
    }

    // as_of: lấy max periodStart
    const as_of = items.reduce((mx, it) => {
        const t = it.periodStart ? new Date(it.periodStart).getTime() : 0;
        return t > mx ? t : mx;
    }, 0);

    return { bank, as_of: as_of ? new Date(as_of) : null, items };
}
