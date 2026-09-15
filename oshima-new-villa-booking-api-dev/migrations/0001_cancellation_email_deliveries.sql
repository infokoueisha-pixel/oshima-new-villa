-- 大島ニュービラ
-- キャンセル・返金完了メール送信履歴
--
-- 既存の email_deliveries は email_type の CHECK 制約があるため、
-- 既存テーブルを壊さず、キャンセル通知専用テーブルを追加する。

CREATE TABLE IF NOT EXISTS cancellation_email_deliveries (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL,
  resend_email_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE INDEX IF NOT EXISTS
  idx_cancellation_email_deliveries_status
ON cancellation_email_deliveries(status);
