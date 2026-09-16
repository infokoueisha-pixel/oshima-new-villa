export async function handleScheduled(event, env, ctx) {
    try {
      const results =
        await env.DB.batch([
          /*
           * 期限切れ予約
           *
           * pending_payment / unpaid のまま
           * hold期限を5分以上超過した予約だけ
           * expired に変更
           */
          env.DB.prepare(`
            UPDATE bookings
            SET
              status = 'expired',
              updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending_payment'
              AND payment_status = 'unpaid'
              AND hold_expires_at IS NOT NULL
              AND datetime(hold_expires_at)
                <= datetime('now', '-5 minutes')
          `),

          /*
           * expired になった予約の
           * 仮押さえ在庫を開放
           *
           * confirmed の予約は絶対に対象にしない
           */
          env.DB.prepare(`
            DELETE FROM inventory_nights
            WHERE allocation_type = 'hold'
              AND EXISTS (
                SELECT 1
                FROM bookings b
                WHERE b.id =
                  inventory_nights.allocation_ref
                  AND b.status = 'expired'
              )
          `),
        ]);

      const expiredBookings =
        results[0]?.meta?.changes || 0;

      const releasedHolds =
        results[1]?.meta?.changes || 0;

      console.log(
        "Expired booking cleanup completed:",
        {
          expired_bookings:
            expiredBookings,
          released_holds:
            releasedHolds,
        }
      );
    } catch (error) {
      console.error(
        "Expired booking cleanup error:",
        error
      );

      /*
       * Cron処理なので、
       * 予約APIそのものには影響させない。
       * 次回Cronで再試行される。
       */
    }
}
