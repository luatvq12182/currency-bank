import puppeteer from "puppeteer";
import axios from "axios";

const TARGET = "https://bidv.com.vn/vn/ty-gia-ngoai-te";
const BANK = "bidv";

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

            document.querySelector("._selected-text.icon-date").click();
            await sleep(200);

            const selectDay = document.querySelector(
                "td[data-handler='selectDay']"
            );

            selectDay.setAttribute("data-month", month);
            selectDay.setAttribute("data-year", year);
            selectDay.querySelector(".ui-state-default").innerText = date;

            selectDay.click();
            await sleep(200);

            document.querySelector("#clickSearch").click();

            await sleep(500);
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

    const today = new Date();
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
            const table = document.querySelector("table");

            if (table.classList.contains("ng-hide")) return null;

            return [...table.querySelectorAll("tr")]
                .map((e) => {
                    return [...e.querySelectorAll("td")].map((td) => {
                        return td.innerText;
                    });
                })
                .filter((_e, i) => i > 0)
                .map((e) => {
                    return {
                        code: e[0],
                        name: e[1],
                        buy_cash:
                            e[2] != "-" ? Number(e[2].replace(/,/g, "")) : 0,
                        buy_transfer:
                            e[3] != "-" ? Number(e[3].replace(/,/g, "")) : 0,
                        sell: e[4] != "-" ? Number(e[4].replace(/,/g, "")) : 0,
                    };
                });
        });

        if (data) {
            for (let j = 0; j < data.length; j++) {
                const payload = {
                    bank: BANK,
                    code: data[j].code,
                    name: data[j].name,
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
