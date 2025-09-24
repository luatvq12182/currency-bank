// scrape-acb.mjs
import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const TARGET = "https://acb.com.vn/ty-gia-hoi-doai";
const OUT_JSON = path.resolve(process.cwd(), "acb-snapshot.json");
const POST_TO_API = Boolean(process.env.ADMIN_API_URL); // nếu có đặt ADMIN_API_URL sẽ gửi
const ADMIN_API_URL = process.env.ADMIN_API_URL || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

/** parse number like "26.147,00" or "26,147" or "26,147.00" -> Number | null */
function parseNumber(text) {
    if (text === null || text === undefined) return null;
    let s = String(text).trim();
    if (!s) return null;
    // remove non-number except , . and -
    s = s.replace(/[^\d,.\-]/g, "");
    // heuristics: if contains both . and , detect thousand separator
    if (s.indexOf(".") !== -1 && s.indexOf(",") !== -1) {
        // assume . thousands, , decimals OR vice versa — we'll normalize:
        // If last comma is after last dot, treat comma as decimal separator -> replace dot thousands
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
            s = s.replace(/\./g, "").replace(",", ".");
        } else {
            s = s.replace(/,/g, "");
        }
    } else if (s.indexOf(",") !== -1 && s.indexOf(".") === -1) {
        // likely comma decimal or thousand; if comma groups of 3 -> remove commas
        // simpler: remove commas (ACB usually shows thousands with commas)
        s = s.replace(/,/g, "");
    } else {
        // only dots or only digits: remove commas (none)
        s = s;
    }
    if (s === "" || s === "-" || s === "—") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Nếu trang có timestamp/ghi chú ngày giờ lấy tỷ giá, parse nếu có */
function normalizePeriodStartFromPage(str) {
    if (!str) return new Date();
    // try to find date patterns like dd/mm/yyyy or yyyy-mm-dd
    const m = str.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (m) {
        const [_, dd, mm, yyyy] = m;
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
    }
    const iso = new Date(str);
    if (!isNaN(iso)) return iso;
    return new Date();
}

/** crawl và extract */
async function scrapeOnce({ headless = true, timeout = 30000 } = {}) {
    const browser = await puppeteer.launch({
        headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
        );
        await page.setViewport({ width: 1280, height: 900 });

        console.log("navigating to", TARGET);
        const res = await page.goto(TARGET, {
            waitUntil: "networkidle2",
            timeout,
        });

        // wait for some table-like element or typical selectors
        const selectorsToWait = [
            "table", // generic
            "table.table", // bootstrap table
            "div.tygia", // custom wrapper maybe
            "section", // fallback
        ];

        let found = false;
        for (const s of selectorsToWait) {
            try {
                await page.waitForSelector(s, { timeout: 4000 });
                found = true;
                // break; // keep waiting multiple? we'll break to query later
                break;
            } catch (e) {
                // continue
            }
        }
        if (!found) {
            console.warn(
                "Không tìm thấy selector table rõ ràng — sẽ cố gắng lấy tất cả table trên trang"
            );
        }

        // get page note or timestamp if exists
        const pageNote = await page
            .$eval("body", (b) => {
                // attempt to find visible text containing 'cập nhật' or 'ngày' etc
                const text = b.innerText || "";
                const lines = text
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);
                // find first line mentioning cập nhật/ngày
                const clue = lines.find((l) =>
                    /cập nhật|ngày|ngày cập nhật|cập nhật lúc|ty gia/i.test(l)
                );
                return clue || null;
            })
            .catch(() => null);

        // extract from the most relevant table: choose table whose header contains "Mã" "Mua" or "Bán"
        const data = await page
            .$$eval("table", (tables, parseNumberFnSource) => {
                // parseNumberFnSource not used here — we'll do parsing in Node side for reliability
                const out = [];
                for (const table of tables) {
                    const txt = (table.innerText || "").toLowerCase();
                    if (!/mã|mua|bán|ngoại tệ|mua vào|bán ra/.test(txt)) {
                        continue;
                    }
                    // parse rows
                    const rows = Array.from(table.querySelectorAll("tbody tr"));
                    for (const r of rows) {
                        // skip header-like
                        if (
                            r.querySelectorAll("th").length > 0 &&
                            r.querySelectorAll("td").length === 0
                        )
                            continue;
                        const ths = Array.from(r.querySelectorAll("th"));
                        const tds = Array.from(r.querySelectorAll("td"));
                        // Many bank tables put code inside th and values in td
                        // heuristics:
                        let code = null,
                            name = null;
                        if (ths.length >= 1) {
                            code = ths[0].innerText.trim();
                            if (ths.length >= 2) name = ths[1].innerText.trim();
                        } else if (tds.length >= 4) {
                            // or code maybe in first td
                            code = tds[0].innerText.trim();
                        }
                        // collect numeric columns from the last tds
                        const numbers = tds.map((td) => td.innerText.trim());
                        out.push({
                            raw_th: ths.map((x) => x.innerText.trim()),
                            raw_td: numbers,
                            code,
                            name,
                        });
                    }
                    if (out.length) break; // stop after first matching table
                }
                return out;
            })
            .catch((e) => {
                console.error("page.$$eval error", e);
                return [];
            });

        // post-processing: try to map raw_td to buy_cash, buy_transfer, sell
        // heuristics: if there are 3 numeric columns -> [buy, transfer, sell] or [mua vào,bán ra] for simple tables -> [buy, sell]
        const items = [];
        for (const row of data) {
            const { code: maybeCode, name: maybeName, raw_td, raw_th } = row;
            // try to detect currency code like USD/AUD etc inside maybeCode or maybeName
            let code = (maybeCode || "").match(/\b[A-Z]{3}\b/)
                ? maybeCode.match(/\b[A-Z]{3}\b/)[0]
                : null;
            if (!code && maybeName) {
                const m = maybeName.match(/\b([A-Z]{3})\b/);
                if (m) code = m[1];
            }

            // if still not, try raw_th first element
            if (!code && raw_th && raw_th.length) {
                const m = raw_th[0].match(/\b([A-Z]{3})\b/);
                if (m) code = m[1];
            }

            // pick display name:
            const name = maybeName || (raw_th && raw_th[1]) || maybeCode || "";

            // normalize numeric columns: trim arrows/icons
            const cleanedNumbers = raw_td.map((s) =>
                s
                    .replace(/[\n\r\t]/g, " ")
                    .replace(/[^0-9,.\-]/g, "")
                    .trim()
            );

            // Determine mapping:
            let buy_cash = null,
                buy_transfer = null,
                sell = null;
            if (cleanedNumbers.length >= 3) {
                buy_cash = cleanedNumbers[0];
                buy_transfer = cleanedNumbers[1];
                sell = cleanedNumbers[2];
            } else if (cleanedNumbers.length === 2) {
                // two-col table -> buy, sell
                buy_transfer = cleanedNumbers[0];
                sell = cleanedNumbers[1];
            } else if (cleanedNumbers.length === 1) {
                sell = cleanedNumbers[0];
            }

            // final push raw strings (we'll parse to Number in Node)
            items.push({ code, name, buy_cash, buy_transfer, sell });
        }

        const periodStart = normalizePeriodStartFromPage(pageNote);

        // convert numeric strings to numbers by sending to Node parseNumber (but we can't call Node function inside browser eval)
        // so we return raw strings and parse here
        await browser.close();
        return { items, pageNote, periodStart: periodStart.toISOString() };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

/** wrapper to parse numbers and prepare payload for API */
function buildPayloadFromScrape(scrapeResult) {
    const now = new Date();
    const periodStart = new Date(scrapeResult.periodStart); // iso
    const outItems = [];
    for (const it of scrapeResult.items) {
        // skip empty rows
        if (!it.code && !it.name) continue;
        const code = (it.code || "").toString().trim().toUpperCase();
        const name = (it.name || "").toString().trim() || null;
        const buy_cash = parseNumber(it.buy_cash);
        const buy_transfer = parseNumber(it.buy_transfer);
        const sell = parseNumber(it.sell);

        // if all null, skip
        if (buy_cash === null && buy_transfer === null && sell === null)
            continue;

        outItems.push({
            bank: "acb", // you are scraping ACB
            code,
            name,
            buy_cash,
            buy_transfer,
            sell,
            periodStart: periodStart.toISOString(), // will be normalized by API to round hour
            source: TARGET,
        });
    }
    return outItems;
}

/** optionally send to your internal API bulk endpoint */
async function postToAdminApi(payloadItems) {
    if (!POST_TO_API) return { posted: false, reason: "ADMIN_API_URL not set" };
    try {
        const resp = await axios.post(
            ADMIN_API_URL,
            { items: payloadItems },
            {
                headers: {
                    "Content-Type": "application/json",
                    ...(ADMIN_API_KEY ? { "x-api-key": ADMIN_API_KEY } : {}),
                },
                timeout: 20000,
            }
        );
        return { posted: true, status: resp.status, data: resp.data };
    } catch (e) {
        return {
            posted: false,
            error: e.message,
            detail: e.response?.data || null,
        };
    }
}

/** main */
(async () => {
    try {
        console.log("start scrape ACB...");
        const result = await scrapeOnce({
            headless: false,
        });
        console.log("page note (clue):", result.pageNote);
        const items = buildPayloadFromScrape(result);

        console.log("extracted items:", items.length);
        // save to file
        await fs.writeFile(
            OUT_JSON,
            JSON.stringify(
                { crawled_at: new Date().toISOString(), items },
                null,
                2
            )
        );
        console.log("saved to", OUT_JSON);

        // post to admin API if configured
        if (POST_TO_API && items.length) {
            console.log("posting to admin API:", ADMIN_API_URL);

            console.log('Trời ơi: ', items);
            // const postRes = await postToAdminApi(items);
            // console.log("post result:", postRes);
        } else {
            console.log("POST skipped (ADMIN_API_URL not set or no items)");
        }

        console.log("done.");
        process.exit(0);
    } catch (e) {
        console.error("scrape error:", e);
        process.exit(2);
    }
})();
