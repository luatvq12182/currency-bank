import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import { connectDB } from "./db.mjs";
import apiRoutes from "./routes.mjs";
import { startScheduler } from "./scheduler.mjs";

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.get("/", (req, res) => {
    res.type("text").send(
        [
            "TygiaUSD Crawler API",
            "Endpoints:",
            "GET  /api/latest?bank=vietcombank&code=USD&field=sell",
            "GET  /api/compare?bank=vietcombank&code=USD&field=sell",
            "GET  /api/history?bank=vietcombank&code=USD&range=1m&field=sell",
            "GET  /api/daily-ohlc?bank=vietcombank&code=USD&date=2025-09-16&field=sell",
            "POST /api/admin/crawl-now",
        ].join("\n")
    );
});

app.use("/api", apiRoutes);

const PORT = Number(process.env.PORT || 3000);

(async () => {
    try {
        await connectDB(process.env.MONGODB_URI);
        app.listen(PORT, () =>
            console.log(`[server] http://localhost:${PORT}`)
        );
        startScheduler(); // bắt đầu cron mỗi giờ
    } catch (e) {
        console.error("[boot] fail:", e);
        process.exit(1);
    }
})();
