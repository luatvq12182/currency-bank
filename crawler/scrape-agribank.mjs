import puppeteer from "puppeteer";
import axios from "axios";

const TARGET = "https://www.agribank.com.vn/vn/ty-gia";

const setDatePicker = async (page, date, month, year) => {
    await page.evaluate(
        async ({ date, month, year }) => {
            const sleep = (ms) => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve();
                    }, ms);
                });
            };

            document.querySelector(".ccy_date").click();
            await sleep(200);

            const selectDay = document.querySelector(
                "td[data-handler='selectDay']"
            );

            selectDay.setAttribute("data-month", month);
            selectDay.setAttribute("data-year", year);
            selectDay.querySelector(".ui-state-default").innerText = date;

            selectDay.click();

            await sleep(1000);
        },
        { date, month, year }
    );
};

const main = async () => {
    const browser = await puppeteer.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    await page.setViewport({ width: 1500, height: 900 });
    await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 40000 });

    const today = new Date("2025-05-22");
    today.setHours(9, 0, 0, 0);

    for (let i = 1; i <= 365; i++) {
        today.setDate(today.getDate() - 1);

        await setDatePicker(
            page,
            today.getDate(),
            today.getMonth(),
            today.getFullYear()
        );

        const data = await page.evaluate(() => {
            const table = document.querySelector("#tyGiaCn table");

            if (!table) return null;

            return [...document.querySelector("table").querySelectorAll("tr")]
                .map((e) => {
                    return [...e.querySelectorAll("td")].map((td) => {
                        return td.innerText;
                    });
                })
                .filter((e) => e.length > 0)
                .map((e) => {
                    return {
                        code: e[0],
                        buy_cash: Number(e[1].replace(/,/g, "")),
                        buy_transfer: Number(e[2].replace(/,/g, "")),
                        sell: Number(e[3].replace(/,/g, "")),
                    };
                });
        });

        const currencyVietsub = {
            USD: "Đô la Mỹ",
            EUR: "Euro",
            GBP: "Bảng Anh",
            HKD: "Đô la Hồng Kông",
            CHF: "Franc Thụy Sĩ",
            JPY: "Yên Nhật",
            AUD: "Đô la Úc",
            SGD: "Đô la Singapore",
            THB: "Baht Thái Lan",
            CAD: "Đô la Canada",
            NZD: "Đô la New Zealand",
            KRW: "Won Hàn Quốc",
            DKK: "Krone Đan Mạch",
            NOK: "Krone Na Uy",
            SEK: "Krone Thụy Điển",
            CNY: "Nhân dân tệ (Trung Quốc)",
            KWD: "Dinar Kuwait",
            INR: "Rupee Ấn Độ",
            MYR: "Ringgit Malaysia",
            RUB: "Rúp Nga",
        };

        if (data) {
            for (let j = 0; j < data.length; j++) {
                const payload = {
                    bank: "agribank",
                    code: data[j].code,
                    name: currencyVietsub[data[j].code],
                    buy_cash: data[j].buy_cash,
                    buy_transfer: data[j].buy_transfer,
                    sell: data[j].sell,
                    periodStart: today,
                    source: TARGET,
                };

                try {
                    await axios.post(
                        "http://localhost:3001/api/admin/snapshot",
                        payload,
                        {
                            headers: {
                                "Content-Type": "application/json",
                            },
                            timeout: 20000,
                        }
                    );
                } catch (error) {
                    console.log('Something happening...');
                }
            }

            console.log(
                "Insert done: ",
                today.getDate(),
                today.getMonth(),
                today.getFullYear()
            );
        } else {
            console.log(
                "Không có DATA: ",
                today.getDate(),
                today.getMonth(),
                today.getFullYear()
            );
        }
    }

    console.log("CÀO XONG AGRIBANK");
};

main();
