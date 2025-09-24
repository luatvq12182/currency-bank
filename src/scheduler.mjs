import cron from "node-cron";
import { crawlAllBanks } from "./crawler.mjs";
import { persistSnapshots, roundToHour } from "./services.mjs";

export function startScheduler() {
    // chạy mỗi giờ, phút 0 (theo TZ=Asia/Bangkok trong env)
    cron.schedule(
        "0 * * * *",
        async () => {
            const at = new Date();
            console.log(
                `[cron] crawl all banks @ ${roundToHour(at).toISOString()}`
            );
            try {
                const rows = await crawlAllBanks();
                const res = await persistSnapshots(rows, at);
                console.log(
                    `[cron] persisted: upserted=${res.upserted} modified=${res.modified}`
                );
            } catch (e) {
                console.error("[cron] error:", e.message);
            }
        },
        { timezone: process.env.TZ || "Asia/Bangkok" }
    );

    console.log("[cron] scheduled: every hour at minute 0");
}
