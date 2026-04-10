"use client";

type Milestone = {
  id: string;
  title: string;
  description: string;
  payout_amount: string;
  order_index: number;
  status: "pending" | "unlocked" | "paid" | "failed";
  payout_tx_id: string | null;
};

type MilestoneListProps = {
  milestones: Milestone[];
};

function statusClass(status: Milestone["status"]) {
  if (status === "paid") {
    return "border-[#1b7b30] bg-[#e9ffe9] text-[#1b7b30]";
  }
  if (status === "unlocked") {
    return "border-[#1040c0] bg-[#eef5ff] text-[#1040c0]";
  }
  if (status === "failed") {
    return "border-[#8f1515] bg-[#ffe7e7] text-[#8f1515]";
  }
  return "border-[#7a7a7a] bg-[#f2f2f2] text-[#4b4b4b]";
}

export function MilestoneList({ milestones }: MilestoneListProps) {
  const paidCount = milestones.filter((item) => item.status === "paid").length;
  const progress = milestones.length === 0 ? 0 : (paidCount / milestones.length) * 100;

  return (
    <div className="space-y-3">
      {milestones.map((milestone, index) => {
        const previous = milestones[index - 1];
        const sequenceError =
          milestone.status !== "pending" &&
          previous &&
          previous.status !== "paid";

        return (
          <div key={milestone.id} className="rounded-none border-2 border-[#121212] bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-1 flex h-7 w-7 items-center justify-center rounded-full border text-xs font-black ${
                    milestone.status === "paid"
                      ? "border-[#1b7b30] bg-[#1b7b30] text-white"
                      : "border-[#121212] bg-white text-[#121212]"
                  }`}
                >
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-semibold">{milestone.title}</p>
                  <p className="text-xs text-[#4b4b4b]">{milestone.description}</p>
                  {sequenceError ? (
                    <p className="mt-1 text-xs text-[#8f1515]">
                      Previous milestone must be completed first.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="text-right">
                <p className="text-sm font-bold text-[#6e5a00]">{Number(milestone.payout_amount) / 1_000_000} ALGO</p>
                <span className={`mt-1 inline-flex border px-2 py-1 text-xs font-semibold ${statusClass(milestone.status)}`}>
                  {milestone.status}
                </span>
                {milestone.payout_tx_id ? (
                  <a
                    href={`https://testnet.explorer.perawallet.app/tx/${milestone.payout_tx_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block text-xs underline"
                  >
                    View Payout Tx
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      <div className="h-2 w-full overflow-hidden border border-[#121212] bg-[#f4f4f4]">
        <div className="h-full bg-[linear-gradient(90deg,#1040c0,#1b7b30)]" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
