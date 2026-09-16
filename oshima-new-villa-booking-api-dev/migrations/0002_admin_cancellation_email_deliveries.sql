-- 大島ニュービラ
-- 管理者向けキャンセル・返金通知メール送信履歴

CREATE TABLE IF NOT EXISTS admin_cancellation_email_deliveries (
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
  idx_admin_cancellation_email_deliveries_status
ON admin_cancellation_email_deliveries(status);
