import { getCancellationReasonLabel, escapeEmailHtml } from "../lib/format.js";

/*
 * お客様へキャンセル・返金完了メールを送信する。
 *
 * メール障害では予約キャンセル・Stripe返金を失敗扱いにしない。
 * cancellation_email_deliveries で二重送信を防止する。
 */
async function sendCancellationCompletionEmail(
  env,
  bookingId,
  options = {}
) {
  const emailBooking =
    await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.customer_name,
          b.customer_email,
          b.check_in_date,
          b.check_out_date,
          b.guest_count,
          b.total_jpy,

          p.name AS product_name,

          c.reason_code,
          c.policy_rate,
          c.cancellation_fee_jpy,
          c.refund_amount_jpy,
          c.stripe_refund_id,
          c.stripe_refund_status

        FROM bookings b

        JOIN products p
          ON p.id = b.product_id

        JOIN booking_cancellations c
          ON c.booking_id = b.id

        WHERE b.id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (!emailBooking?.customer_email) {
    return "skipped";
  }

  const existingDelivery =
    await env.DB
      .prepare(`
        SELECT
          id,
          status
        FROM cancellation_email_deliveries
        WHERE booking_id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (existingDelivery?.status === "sent") {
    return "already_sent";
  }

  const deliveryId =
    existingDelivery?.id ||
    crypto.randomUUID();

  if (!existingDelivery) {
    await env.DB
      .prepare(`
        INSERT INTO cancellation_email_deliveries (
          id,
          booking_id,
          recipient_email,
          status
        )
        VALUES (?, ?, ?, 'pending')
      `)
      .bind(
        deliveryId,
        bookingId,
        emailBooking.customer_email
      )
      .run();
  } else {
    await env.DB
      .prepare(`
        UPDATE cancellation_email_deliveries
        SET
          recipient_email = ?,
          status = 'pending',
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        emailBooking.customer_email,
        deliveryId
      )
      .run();
  }

  const formattedTotal =
    Number(
      emailBooking.total_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedFee =
    Number(
      emailBooking.cancellation_fee_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedRefund =
    Number(
      emailBooking.refund_amount_jpy || 0
    ).toLocaleString("ja-JP");

  const reasonLabel =
    getCancellationReasonLabel(
      emailBooking.reason_code
    );

  let refundMessageText = "";

  let refundMessageHtml = "";

  if (
    Number(
      emailBooking.refund_amount_jpy || 0
    ) <= 0
  ) {
    refundMessageText =
      "今回の返金額は0円です。";

    refundMessageHtml =
      "今回の返金額は<strong>0円</strong>です。";
  } else if (
    emailBooking.stripe_refund_status ===
    "succeeded"
  ) {
    refundMessageText =
      "Stripeで返金処理は完了しています。カード会社側での返金反映時期は、ご利用のカード会社によって異なります。";

    refundMessageHtml =
      "Stripeで<strong>返金処理は完了しています。</strong><br>カード会社側での返金反映時期は、ご利用のカード会社によって異なります。";
  } else {
    refundMessageText =
      "Stripeで返金処理を受け付けています。カード会社側への反映まで時間がかかる場合があります。";

    refundMessageHtml =
      "Stripeで<strong>返金処理を受け付けています。</strong><br>カード会社側への反映まで時間がかかる場合があります。";
  }

  const subject =
    `【大島ニュービラ】ご予約キャンセルのお知らせ｜${emailBooking.public_booking_code}`;

  const textBody = `
${emailBooking.customer_name} 様

大島ニュービラをご予約いただき、ありがとうございました。
以下のご予約について、キャンセル手続きが完了しました。

■ 予約番号
${emailBooking.public_booking_code}

■ 宿泊施設
${emailBooking.product_name}

■ チェックイン
${emailBooking.check_in_date}

■ チェックアウト
${emailBooking.check_out_date}

■ 宿泊人数
${emailBooking.guest_count}名

■ キャンセル理由
${reasonLabel}

■ お支払い済み金額
¥${formattedTotal}

■ キャンセル料率
${emailBooking.policy_rate}%

■ キャンセル料
¥${formattedFee}

■ 返金額
¥${formattedRefund}

${refundMessageText}

ご不明な点がございましたら、大島ニュービラまでお問い合わせください。

大島ニュービラ
https://oshima-new-villa.com/

※このメールは自社予約システムより自動送信されています。
  `.trim();

  const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.8;
">

  <h2 style="margin-bottom:8px;">
    大島ニュービラ
  </h2>

  <p>
    ${escapeEmailHtml(
      emailBooking.customer_name
    )} 様
  </p>

  <p>
    大島ニュービラをご予約いただき、
    ありがとうございました。<br>
    以下のご予約について、
    <strong>キャンセル手続きが完了しました。</strong>
  </p>

  <div style="
    background:#f7f7f7;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeEmailHtml(
        emailBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeEmailHtml(
        emailBooking.product_name
      )}
    </p>

    <p>
      <strong>宿泊日</strong><br>
      ${escapeEmailHtml(
        emailBooking.check_in_date
      )}
      ～
      ${escapeEmailHtml(
        emailBooking.check_out_date
      )}
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${emailBooking.guest_count}名
    </p>

    <p>
      <strong>キャンセル理由</strong><br>
      ${escapeEmailHtml(
        reasonLabel
      )}
    </p>

  </div>

  <div style="
    border:1px solid #ddd;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>お支払い済み金額</strong><br>
      ¥${formattedTotal}
    </p>

    <p>
      <strong>キャンセル料率</strong><br>
      ${emailBooking.policy_rate}%
    </p>

    <p>
      <strong>キャンセル料</strong><br>
      ¥${formattedFee}
    </p>

    <p style="margin-bottom:8px;">
      <strong>返金額</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedRefund}
      </span>
    </p>

    <p style="
      margin-top:16px;
      margin-bottom:0;
      font-size:14px;
    ">
      ${refundMessageHtml}
    </p>

  </div>

  <p>
    ご不明な点がございましたら、
    大島ニュービラまでお問い合わせください。
  </p>

  <p>
    <a href="https://oshima-new-villa.com/">
      大島ニュービラ公式サイト
    </a>
  </p>

  <p style="
    margin-top:32px;
    font-size:13px;
    color:#666;
  ">
    ※このメールは大島ニュービラ
    自社予約システムより
    自動送信されています。
  </p>

</div>
  `.trim();

  const resendResponse =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json",

          "Idempotency-Key":
            options.idempotencyKey ||
            `onv-cancellation-email-${bookingId}`,
        },

        body: JSON.stringify({
          from:
            "大島ニュービラ <booking@oshima-new-villa.com>",

          to: [
            emailBooking.customer_email,
          ],

          subject,

          text: textBody,

          html: htmlBody,
        }),
      }
    );

  if (resendResponse.ok) {
    const resendResult =
      await resendResponse.json();

    await env.DB
      .prepare(`
        UPDATE cancellation_email_deliveries
        SET
          resend_email_id = ?,
          status = 'sent',
          last_error = NULL,
          sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        resendResult.id,
        deliveryId
      )
      .run();

    return "sent";
  }

  const resendError =
    await resendResponse.json()
      .catch(() => null);

  const errorMessage =
    String(
      resendError?.message ||
      resendError?.name ||
      "resend_error"
    ).slice(0, 500);

  await env.DB
    .prepare(`
      UPDATE cancellation_email_deliveries
      SET
        status = 'failed',
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(
      errorMessage,
      deliveryId
    )
    .run();

  console.error(
    "Cancellation completion email failed:",
    errorMessage
  );

  return "failed";
}


/*
 * 管理者へキャンセル・返金通知メールを送信する。
 *
 * 通知失敗でも、すでに完了した
 * Stripe返金・予約キャンセル・在庫解放は
 * 取り消さない。
 */
async function sendAdminCancellationNotificationEmail(
  env,
  bookingId,
  options = {}
) {
  const adminEmail =
    String(
      env.ADMIN_NOTIFICATION_EMAIL || ""
    ).trim();

  if (!adminEmail) {
    return "skipped";
  }

  const cancellation =
    await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.customer_name,
          b.customer_email,
          b.customer_phone,
          b.check_in_date,
          b.check_out_date,
          b.guest_count,
          b.total_jpy,

          p.name AS product_name,

          c.reason_code,
          c.policy_rate,
          c.cancellation_fee_jpy,
          c.refund_amount_jpy,
          c.stripe_refund_id,
          c.stripe_refund_status,
          c.admin_note

        FROM bookings b

        JOIN products p
          ON p.id = b.product_id

        JOIN booking_cancellations c
          ON c.booking_id = b.id

        WHERE b.id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (!cancellation) {
    return "skipped";
  }

  const existingDelivery =
    await env.DB
      .prepare(`
        SELECT
          id,
          status
        FROM admin_cancellation_email_deliveries
        WHERE booking_id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (existingDelivery?.status === "sent") {
    return "already_sent";
  }

  const deliveryId =
    existingDelivery?.id ||
    crypto.randomUUID();

  if (!existingDelivery) {
    await env.DB
      .prepare(`
        INSERT INTO admin_cancellation_email_deliveries (
          id,
          booking_id,
          recipient_email,
          status
        )
        VALUES (?, ?, ?, 'pending')
      `)
      .bind(
        deliveryId,
        bookingId,
        adminEmail
      )
      .run();
  } else {
    await env.DB
      .prepare(`
        UPDATE admin_cancellation_email_deliveries
        SET
          recipient_email = ?,
          status = 'pending',
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        adminEmail,
        deliveryId
      )
      .run();
  }

  const formattedTotal =
    Number(
      cancellation.total_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedFee =
    Number(
      cancellation.cancellation_fee_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedRefund =
    Number(
      cancellation.refund_amount_jpy || 0
    ).toLocaleString("ja-JP");

  const reasonLabel =
    getCancellationReasonLabel(
      cancellation.reason_code
    );

  const refundStatusLabel =
    cancellation.stripe_refund_status === "succeeded"
      ? "返金完了"
      : cancellation.stripe_refund_status === "not_required"
        ? "返金なし"
        : cancellation.stripe_refund_status === "pending"
          ? "返金処理中"
          : cancellation.stripe_refund_status || "不明";

  const subject =
    `【予約キャンセル】${cancellation.product_name}｜${cancellation.check_in_date}〜${cancellation.check_out_date}｜返金¥${formattedRefund}｜${cancellation.public_booking_code}`;

  const textBody = `
大島ニュービラの自社予約がキャンセルされました。

■ 予約番号
${cancellation.public_booking_code}

■ 宿泊施設
${cancellation.product_name}

■ チェックイン
${cancellation.check_in_date}

■ チェックアウト
${cancellation.check_out_date}

■ 宿泊人数
${cancellation.guest_count}名

■ 予約者名
${cancellation.customer_name}

■ メールアドレス
${cancellation.customer_email}

■ 電話番号
${cancellation.customer_phone || "未登録"}

■ キャンセル理由
${reasonLabel}

■ 管理者メモ
${cancellation.admin_note || "なし"}

■ お支払い済み金額
¥${formattedTotal}

■ キャンセル料率
${cancellation.policy_rate}%

■ キャンセル料
¥${formattedFee}

■ 返金額
¥${formattedRefund}

■ Stripe返金状況
${refundStatusLabel}

■ Stripe返金ID
${cancellation.stripe_refund_id || "なし"}

予約キャンセルおよび在庫解放は完了しています。

大島ニュービラ 自社予約システム
  `.trim();

  const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.7;
">

  <h2>予約がキャンセルされました</h2>

  <div style="
    background:#f7f7f7;
    padding:20px;
    border-radius:8px;
    margin:20px 0;
  ">
    <p>
      <strong>予約番号</strong><br>
      ${escapeEmailHtml(
        cancellation.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeEmailHtml(
        cancellation.product_name
      )}
    </p>

    <p>
      <strong>宿泊日</strong><br>
      ${escapeEmailHtml(
        cancellation.check_in_date
      )}
      ～
      ${escapeEmailHtml(
        cancellation.check_out_date
      )}
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${cancellation.guest_count}名
    </p>
  </div>

  <h3>予約者情報</h3>

  <p>
    <strong>氏名</strong><br>
    ${escapeEmailHtml(
      cancellation.customer_name
    )}
  </p>

  <p>
    <strong>メール</strong><br>
    ${escapeEmailHtml(
      cancellation.customer_email
    )}
  </p>

  <p>
    <strong>電話番号</strong><br>
    ${escapeEmailHtml(
      cancellation.customer_phone ||
        "未登録"
    )}
  </p>

  <h3>キャンセル内容</h3>

  <p>
    <strong>キャンセル理由</strong><br>
    ${escapeEmailHtml(reasonLabel)}
  </p>

  <p>
    <strong>管理者メモ</strong><br>
    ${escapeEmailHtml(
      cancellation.admin_note ||
        "なし"
    )}
  </p>

  <div style="
    border:1px solid #ddd;
    padding:20px;
    border-radius:8px;
    margin:20px 0;
  ">
    <p>
      <strong>お支払い済み金額</strong><br>
      ¥${formattedTotal}
    </p>

    <p>
      <strong>キャンセル料率</strong><br>
      ${cancellation.policy_rate}%
    </p>

    <p>
      <strong>キャンセル料</strong><br>
      ¥${formattedFee}
    </p>

    <p>
      <strong>返金額</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedRefund}
      </span>
    </p>

    <p>
      <strong>Stripe返金状況</strong><br>
      ${escapeEmailHtml(
        refundStatusLabel
      )}
    </p>

    <p style="margin-bottom:0;">
      <strong>Stripe返金ID</strong><br>
      ${escapeEmailHtml(
        cancellation.stripe_refund_id ||
          "なし"
      )}
    </p>
  </div>

  <p style="
    font-size:13px;
    color:#666;
  ">
    予約キャンセルおよび在庫解放は完了しています。
  </p>

</div>
  `.trim();

  const resendResponse =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json",

          "Idempotency-Key":
            options.idempotencyKey ||
            `onv-admin-cancellation-${bookingId}`,
        },

        body: JSON.stringify({
          from:
            "大島ニュービラ予約システム <booking@oshima-new-villa.com>",

          to: [
            adminEmail,
          ],

          subject,

          text: textBody,

          html: htmlBody,
        }),
      }
    );

  if (resendResponse.ok) {
    const resendResult =
      await resendResponse.json();

    await env.DB
      .prepare(`
        UPDATE admin_cancellation_email_deliveries
        SET
          resend_email_id = ?,
          status = 'sent',
          last_error = NULL,
          sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        resendResult.id,
        deliveryId
      )
      .run();

    return "sent";
  }

  const resendError =
    await resendResponse.json()
      .catch(() => null);

  const errorMessage =
    String(
      resendError?.message ||
      resendError?.name ||
      "resend_error"
    ).slice(0, 500);

  await env.DB
    .prepare(`
      UPDATE admin_cancellation_email_deliveries
      SET
        status = 'failed',
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(
      errorMessage,
      deliveryId
    )
    .run();

  console.error(
    "Admin cancellation notification failed:",
    errorMessage
  );

  return "failed";
}

export { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail };
