export type BountyEscrowEvents = {
  "bounty/funded": {
    data: {
      bounty_id: string;
      contract_address: string;
      client_wallet: string;
      amount_micro_algo: number;
    };
  };
  "bounty/accepted": {
    data: {
      bounty_id: string;
      freelancer_id: string;
      freelancer_wallet: string;
      submission_id: string;
    };
  };
  "bounty/expired": {
    data: {
      bounty_id: string;
      reason: "no_submission" | "all_failed" | "grace_elapsed";
    };
  };
  "bounty/deadline_extended": {
    data: {
      bounty_id: string;
      new_deadline: string;
      extension_count: number;
    };
  };
  "bounty/cancelled": {
    data: {
      bounty_id: string;
      refund_tx_id: string;
    };
  };

  "submission/created": {
    data: {
      submission_id: string;
      bounty_id: string;
      freelancer_id: string;
      github_pr_url: string;
    };
  };
  "submission/ci_completed": {
    data: {
      submission_id: string;
      ci_status: "passed" | "failed" | "timeout" | "skipped_abuse";
      skipped_count: number;
      total_count: number;
      run_id: string;
    };
  };
  "submission/scoring_requested": {
    data: {
      submission_id: string;
      bounty_id: string;
      scoring_mode: "ai_only" | "ci_only" | "hybrid";
      cached_diff: string;
    };
  };
  "submission/scored": {
    data: {
      submission_id: string;
      final_score: number;
      passed_threshold: boolean;
      integrity_flag: boolean;
    };
  };
  "submission/abandoned": {
    data: {
      submission_id: string;
      freelancer_id: string;
      bounty_id: string;
    };
  };

  "payout/release_requested": {
    data: {
      submission_id: string;
      bounty_id: string;
      freelancer_wallet: string;
      amount_micro_algo: number;
      is_split: boolean;
      split_map?: Array<{ wallet: string; amount: number }>;
    };
  };
  "payout/opt_in_required": {
    data: {
      freelancer_id: string;
      asset_id: number;
      payout_id: string;
    };
  };
  "payout/completed": {
    data: {
      payout_id: string;
      tx_id: string;
      actual_amount: number;
    };
  };
  "payout/failed": {
    data: {
      payout_id: string;
      reason: string;
      retry_count: number;
    };
  };
  "payout/quarantined": {
    data: {
      payout_id: string;
      wallet: string;
      reason: "sanctions" | "invalid_wallet" | "opt_in_timeout";
    };
  };
  "payout/mismatch_detected": {
    data: {
      payout_id: string;
      expected: number;
      actual: number;
    };
  };

  "milestone/unlock_requested": {
    data: {
      milestone_id: string;
      submission_id: string;
      amount_micro_algo: number;
      order_index: number;
    };
  };
  "milestone/paid": {
    data: {
      milestone_id: string;
      tx_id: string;
    };
  };
  "milestone/failed": {
    data: {
      milestone_id: string;
      reason: string;
    };
  };

  "dispute/opened": {
    data: {
      dispute_id: string;
      submission_id: string;
      raised_by: string;
      dispute_type: string;
    };
  };
  "dispute/vote_cast": {
    data: {
      dispute_id: string;
      arbitrator_id: string;
      votes_in: number;
      votes_needed: number;
    };
  };
  "dispute/all_votes_in": {
    data: {
      dispute_id: string;
    };
  };
  "dispute/escalated": {
    data: {
      dispute_id: string;
      reason: "sla_breach" | "split_vote";
    };
  };
  "dispute/resolved": {
    data: {
      dispute_id: string;
      outcome: "freelancer_wins" | "client_wins" | "split";
      settlement_tx_id: string;
    };
  };

  "notification/send": {
    data: {
      user_id: string;
      event_type: string;
      channels: Array<"email" | "in_app">;
      payload: Record<string, unknown>;
    };
  };

  "system/sanctions_sync": {
    data: { triggered_by: "schedule" | "admin" };
  };
  "system/consistency_check": {
    data: { triggered_by: "schedule" };
  };
  "system/platform_downtime_started": {
    data: { downtime_id: string };
  };
  "system/platform_downtime_ended": {
    data: { downtime_id: string; duration_seconds: number };
  };

  "ci_validation/requested": {
    data: {
      submission_id: string;
      delivery_id?: string;
    };
  };
  "ai_scoring/requested": {
    data: {
      submission_id: string;
      bounty_id: string;
      cached_diff: string;
      ci_status?: "pending" | "running" | "passed" | "failed" | "skipped_abuse" | "timeout" | "ci_not_found";
      scoring_mode: "ai_only" | "ci_only" | "hybrid";
      event_hash?: string;
      retry_count?: number;
    };
  };
  "payout_release/requested": {
    data: {
      submission_id: string;
      bounty_id: string;
      final_score: number;
    };
  };
  "milestone_release/requested": {
    data: {
      milestone_id: string;
      submission_id: string;
      approved_by_client?: boolean;
    };
  };
  "dispute_resolution/requested": {
    data: {
      dispute_id: string;
    };
  };
  "send_notification/requested": {
    data: {
      user_id?: string;
      recipients?: string[];
      event_type: string;
      payload?: Record<string, unknown>;
      channels?: "email" | "in_app" | "both" | Array<"email" | "in_app" | "both">;
      channel?: "email" | "in_app" | "both" | "email+in_app";
      subject?: string;
      [key: string]: unknown;
    };
  };
  "payout_share/retry_requested": {
    data: {
      payout_id: string;
      submission_id: string;
      bounty_id: string;
      reason?: string | null;
    };
  };
  "admin/alert": {
    data: Record<string, unknown>;
  };
};
