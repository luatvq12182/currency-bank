import axios from "axios";
import * as cheerio from "cheerio";

// danh sách bank slug theo menu
export const BANKS = [
    "vietcombank",
    "acb",
    "agribank",
    "bidv",
    // "dongabank",
    "eximbank",
    "hsbc",
    "sacombank",
    "scb",
    "shbbank",
    "techcombank",
    "tpbank",
    "vib",
    "vietinbank",
];

const BASE = "http://tygiausd.org";

function parseNumber(text) {
    if (!text) return null;
    const cleaned = text
        .replace(/[^\d,.-]/g, "")
        .replace(/\s+/g, "")
        .replace(/,/g, "");
    if (!cleaned || cleaned === "-") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

async function fetchHTML(url) {
    const res = await axios.get(url, {
        timeout: 15000,
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
        },
        validateStatus: (s) => s >= 200 && s < 400,
    });
    return res.data;
}

function parseBankTable($, bankSlug) {
    // lấy table chứa chữ "Tỷ Giá <Tên ngân hàng>" hoặc "Tỷ Giá"
    const table = $("table.table.table-condensed.table-hover.table-bordered")
        .filter((_, el) => $(el).text().trim().includes("Tỷ Giá"))
        .first();

    const rows = [];
    if (!table.length) return rows;

    table.find("tbody > tr").each((_, tr) => {
        const $tr = $(tr);
        if ($tr.hasClass("bg-success")) return;

        const ths = $tr.find("th");
        const tds = $tr.find("td");
        if (ths.length >= 2 && tds.length >= 3) {
            const code =
                $(ths[0]).find("a").first().text().trim() ||
                $(ths[0]).text().trim().split(/\s+/)[0] ||
                null;

            const name = $(ths[1]).text().trim() || null;

            const buyText = $(tds[0])
                .clone()
                .children("span")
                .remove()
                .end()
                .text()
                .trim();
            const tranText = $(tds[1])
                .clone()
                .children("span")
                .remove()
                .end()
                .text()
                .trim();
            const sellText = $(tds[2])
                .clone()
                .children("span")
                .remove()
                .end()
                .text()
                .trim();

            rows.push({
                bank: bankSlug,
                code,
                name,
                buy_cash: parseNumber(buyText),
                buy_transfer: parseNumber(tranText),
                sell: parseNumber(sellText),
            });
        }
    });

    return rows;
}

export async function crawlOneBank(bankSlug) {
    const url = `${BASE}/nganhang/${encodeURIComponent(bankSlug)}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const rows = parseBankTable($, bankSlug);
    return { url, rows };
}

/** Crawl toàn bộ ngân hàng, trả về mảng {bank, code, ... , source} */
export async function crawlAllBanks() {
    const out = [];
    for (const bank of BANKS) {
        try {
            const { url, rows } = await crawlOneBank(bank);
            rows.forEach((r) => out.push({ ...r, source: url }));
        } catch (e) {
            console.error("[crawl] failed bank:", bank, e.message);
        }
    }
    return out;
}
