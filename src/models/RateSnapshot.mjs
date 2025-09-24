import mongoose from "mongoose";

const RateSnapshotSchema = new mongoose.Schema(
    {
        bank: { type: String, index: true }, // ví dụ: 'vietcombank'
        code: { type: String, index: true }, // ví dụ: 'USD'
        name: { type: String },

        // các trường giá
        buy_cash: { type: Number, default: null },
        buy_transfer: { type: Number, default: null },
        sell: { type: Number, default: null },

        source: { type: String }, // url crawl
        periodStart: { type: Date, index: true }, // thời điểm snapshot (làm tròn về đầu giờ)
    },
    { timestamps: true }
);

// 1 snapshot / giờ / bank / code
RateSnapshotSchema.index(
    { bank: 1, code: 1, periodStart: 1 },
    { unique: true }
);

export const RateSnapshot = mongoose.model("RateSnapshot", RateSnapshotSchema);
