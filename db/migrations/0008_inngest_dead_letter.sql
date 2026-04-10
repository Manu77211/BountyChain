SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id BIGSERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  error TEXT NOT NULL,
  job_name TEXT,
  step_name TEXT,
  run_id TEXT,
  attempt INTEGER,
  max_attempts INTEGER,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dead_letter_jobs_failed_at_idx
  ON dead_letter_jobs (failed_at DESC);

CREATE INDEX IF NOT EXISTS dead_letter_jobs_event_name_idx
  ON dead_letter_jobs (event_name);
